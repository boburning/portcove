use std::{
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::null_mut,
};

use windows_sys::Win32::{
    Foundation::{ERROR_SUCCESS, LocalFree},
    Security::{
        ACE_HEADER,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetTokenInformation, IsValidAcl, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::CreateDirectoryW,
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

/// A protected DACL granting the current account full access and nobody else.
pub(crate) struct CurrentUserDescriptor(PSECURITY_DESCRIPTOR);

impl CurrentUserDescriptor {
    pub(crate) fn for_object() -> io::Result<Self> {
        let sid = current_user_sid()?;
        Self::from_sddl(&format!("D:P(A;;GA;;;{sid})"))
    }

    fn for_directory_tree() -> io::Result<Self> {
        let sid = current_user_sid()?;
        Self::from_sddl(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})"))
    }

    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: NUL-terminated SDDL and a writable output pointer; the
        // allocation is released by Drop with LocalFree.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }

    pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for CurrentUserDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn current_user_sid() -> io::Result<String> {
    let mut raw_token = std::ptr::null_mut();
    // SAFETY: valid output pointer and the current process pseudo handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken succeeded and gave this function ownership.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
    // Aligned fixed storage bounds TOKEN_USER and the maximum Windows SID.
    let mut storage = [0_usize; 128];
    let mut length = 0_u32;
    // SAFETY: aligned writable storage and the live query token.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            std::mem::size_of_val(&storage) as u32,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if (length as usize) < std::mem::size_of::<TOKEN_USER>() {
        return Err(io::Error::other("invalid account token size"));
    }
    // SAFETY: the OS initialized a complete TOKEN_USER in aligned storage.
    let sid = unsafe { (*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text = std::ptr::null_mut();
    // SAFETY: the SID lives in `storage`; the returned string is LocalFree'd.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Windows returned a NUL-terminated UTF-16 string.
    let value = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        value
    };
    Ok(value)
}

pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
    let descriptor = CurrentUserDescriptor::for_directory_tree()?;
    let name = wide_path(path);
    // SAFETY: the NUL-terminated name and security attributes live through CreateDirectoryW.
    if unsafe { CreateDirectoryW(name.as_ptr(), &descriptor.attributes()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn require_private_directory(path: &Path) -> io::Result<()> {
    let name = wide_path(path);
    let mut actual = null_mut();
    // SAFETY: the path and output pointer are valid. Windows owns allocation
    // until success, after which CurrentUserDescriptor releases it.
    let result = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut actual,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    if actual.is_null() {
        return Err(insecure_directory());
    }
    let actual = CurrentUserDescriptor(actual);
    let expected = CurrentUserDescriptor::for_directory_tree()?;
    if !same_owner(&actual, &expected)?
        || single_protected_ace(&actual)? != single_protected_ace(&expected)?
    {
        return Err(insecure_directory());
    }
    Ok(())
}

fn same_owner(
    actual: &CurrentUserDescriptor,
    expected: &CurrentUserDescriptor,
) -> io::Result<bool> {
    let mut actual_owner = null_mut();
    let mut expected_owner = null_mut();
    let mut defaulted = 0;
    // SAFETY: both descriptors remain live for these owner SID reads and comparison.
    unsafe {
        if GetSecurityDescriptorOwner(actual.0, &mut actual_owner, &mut defaulted) == 0
            || GetSecurityDescriptorOwner(expected.0, &mut expected_owner, &mut defaulted) == 0
            || actual_owner.is_null()
            || expected_owner.is_null()
        {
            return Err(insecure_directory());
        }
        Ok(EqualSid(actual_owner, expected_owner) != 0)
    }
}

fn single_protected_ace(descriptor: &CurrentUserDescriptor) -> io::Result<&[u8]> {
    let mut control = 0;
    let mut revision = 0;
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = null_mut();
    // SAFETY: the descriptor is an OS allocation kept alive by the borrowed
    // owner. Outputs are initialized and the ACE must belong to a valid ACL.
    unsafe {
        if GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED == 0
            || GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) == 0
            || present == 0
            || acl.is_null()
            || IsValidAcl(acl) == 0
            || (*acl).AceCount != 1
        {
            return Err(insecure_directory());
        }
        let mut ace = null_mut();
        if GetAce(acl, 0, &mut ace) == 0 || ace.is_null() {
            return Err(insecure_directory());
        }
        let size = (*ace.cast::<ACE_HEADER>()).AceSize as usize;
        Ok(std::slice::from_raw_parts(ace.cast::<u8>(), size))
    }
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn insecure_directory() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "recovery bundle staging needs a private directory with a protected access list",
    )
}
