//! Preserve the original configuration's owner-relative DACL semantics. Stages
//! stay share-exclusive until their security is verified and data is written.

use super::*;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_TOKEN, LocalFree},
    Security::{
        ACL,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, GetSecurityDescriptorSacl, GetTokenInformation, IsValidAcl,
        IsValidSid, IsWellKnownSid, LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        SYSTEM_MANDATORY_LABEL_ACE, TOKEN_MANDATORY_LABEL, TOKEN_OWNER, TOKEN_QUERY,
        TokenIntegrityLevel, TokenOwner, UNPROTECTED_DACL_SECURITY_INFORMATION, WinMediumLabelSid,
    },
    System::Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
};

// Windows SDK SYSTEM_MANDATORY_LABEL_ACE_TYPE and NO_WRITE_UP values. The v1
// editor does not change labels or enable relabel/security privileges.
const MANDATORY_LABEL_ACE_TYPE: u8 = 0x11;
const DEFAULT_INTEGRITY_POLICY: u32 = 1;

// File creation/access honors thread impersonation. Query that exact effective
// context; an unreadable or anonymous thread token must never fall back to the
// more privileged process token.
fn effective_token() -> Result<OwnedHandle> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: thread pseudo-handle and initialized output. OpenAsSelf changes
    // the access check only; Windows still returns the thread token.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_NO_TOKEN as i32) {
            return Err(error.into());
        }
        // SAFETY: only an absent impersonation token selects this process token.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    // SAFETY: exactly one successful token open transferred this real handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn token_integrity_level(token: &OwnedHandle) -> Result<u32> {
    let mut integrity_size = 0;
    // SAFETY: size-only query on this owned TOKEN_QUERY handle.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle() as _,
            TokenIntegrityLevel,
            std::ptr::null_mut(),
            0,
            &mut integrity_size,
        );
    }
    if integrity_size < size_of::<TOKEN_MANDATORY_LABEL>() as u32 || integrity_size > 4096 {
        return Err(changed());
    }
    let mut integrity = vec![0usize; (integrity_size as usize).div_ceil(size_of::<usize>())];
    // SAFETY: aligned output covers the bounded token information size.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as _,
            TokenIntegrityLevel,
            integrity.as_mut_ptr().cast(),
            integrity_size,
            &mut integrity_size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let sid = unsafe {
        (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
            .Label
            .Sid
    };
    // The query returns a Windows-owned SID inside this live output buffer.
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(changed());
    }
    // Windows-returned SID is valid and remains within the live query buffer.
    let count = unsafe { windows_sys::Win32::Security::GetSidSubAuthorityCount(sid) };
    if count.is_null() || unsafe { *count } != 1 {
        return Err(changed());
    }
    Ok(unsafe { *windows_sys::Win32::Security::GetSidSubAuthority(sid, 0) })
}

struct IntegrityLabel {
    sid: PSID,
    policy: u32,
}

struct SecuritySnapshot {
    descriptor: PSECURITY_DESCRIPTOR,
    owner: PSID,
    dacl: *mut ACL,
    present: bool,
    protected: bool,
    label: Option<IntegrityLabel>,
}

impl Drop for SecuritySnapshot {
    fn drop(&mut self) {
        // SAFETY: successful GetSecurityInfo allocated this exact descriptor
        // with LocalAlloc; this wrapper owns it and frees it exactly once.
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

impl SecuritySnapshot {
    fn capture(file: &File) -> Result<Self> {
        let mut descriptor = std::ptr::null_mut();
        let mut owner = std::ptr::null_mut();
        // SAFETY: all output pointers refer to initialized locals; the borrowed
        // file handle remains live. FILE_GENERIC_READ includes READ_CONTROL.
        let result = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as _,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if result != 0 {
            return Err(std::io::Error::from_raw_os_error(result as i32).into());
        }
        if descriptor.is_null() {
            return Err(changed());
        }
        let mut snapshot = Self {
            descriptor,
            owner,
            dacl: std::ptr::null_mut(),
            present: false,
            protected: false,
            label: None,
        };
        let mut present = 0;
        let mut defaulted = 0;
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: these APIs inspect the live Windows-returned descriptor and
        // write only to initialized output locals of the exact declared types.
        if unsafe {
            GetSecurityDescriptorDacl(
                snapshot.descriptor,
                &mut present,
                &mut snapshot.dacl,
                &mut defaulted,
            )
        } == 0
            || unsafe {
                GetSecurityDescriptorControl(snapshot.descriptor, &mut control, &mut revision)
            } == 0
            || snapshot.owner.is_null()
            || unsafe { IsValidSid(snapshot.owner) } == 0
            || (!snapshot.dacl.is_null() && unsafe { IsValidAcl(snapshot.dacl) } == 0)
        {
            return Err(changed());
        }
        snapshot.present = present != 0;
        snapshot.protected = control & SE_DACL_PROTECTED != 0;
        snapshot.label = snapshot.read_label()?;
        Ok(snapshot)
    }

    fn read_label(&self) -> Result<Option<IntegrityLabel>> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut sacl = std::ptr::null_mut();
        // SAFETY: LABEL_SECURITY_INFORMATION requires READ_CONTROL, not a
        // SACL/security privilege. All pointers belong to the live descriptor.
        if unsafe {
            GetSecurityDescriptorSacl(self.descriptor, &mut present, &mut sacl, &mut defaulted)
        } == 0
        {
            return Err(changed());
        }
        if present == 0 || sacl.is_null() {
            return Ok(None);
        }
        if unsafe { IsValidAcl(sacl) } == 0 {
            return Err(changed());
        }
        let count = unsafe { (*sacl).AceCount };
        if count == 0 {
            return Ok(None);
        }
        if count != 1 {
            return Err(PortcoveError::unsupported(
                "configuration integrity policy is not supported for editing",
            ));
        }
        let mut ace = std::ptr::null_mut();
        if unsafe { GetAce(sacl, 0, &mut ace) } == 0 || ace.is_null() {
            return Err(changed());
        }
        let acl_begin = sacl as usize;
        let acl_end = acl_begin
            .checked_add(unsafe { (*sacl).AclSize } as usize)
            .ok_or_else(changed)?;
        let begin = ace as usize;
        let sid_offset = offset_of!(SYSTEM_MANDATORY_LABEL_ACE, SidStart);
        if begin < acl_begin + size_of::<ACL>()
            || begin
                .checked_add(sid_offset + 8)
                .is_none_or(|end| end > acl_end)
        {
            return Err(changed());
        }
        let label = ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>();
        let header = unsafe { (*label).Header };
        let length = header.AceSize as usize;
        if header.AceType != MANDATORY_LABEL_ACE_TYPE
            || length < sid_offset + 8
            || begin.checked_add(length).is_none_or(|end| end > acl_end)
        {
            return Err(changed());
        }
        // SID length is its fixed 8-byte header plus four bytes per subauthority.
        // Check the count inside this ACE before asking Windows to inspect it.
        let sid = unsafe { ace.cast::<u8>().add(sid_offset) };
        let sid_length = 8 + usize::from(unsafe { *sid.add(1) }) * 4;
        if sid_length > length - sid_offset || unsafe { IsValidSid(sid.cast()) } == 0 {
            return Err(changed());
        }
        Ok(Some(IntegrityLabel {
            sid: sid.cast(),
            policy: unsafe { (*label).Mask },
        }))
    }

    fn has_default_medium_integrity(&self) -> bool {
        self.label.as_ref().is_none_or(|label| {
            label.policy == DEFAULT_INTEGRITY_POLICY
                // SAFETY: capture bounded and validated this descriptor-owned SID.
                && unsafe { IsWellKnownSid(label.sid, WinMediumLabelSid) } != 0
        })
    }

    fn same_integrity(&self, other: &Self) -> bool {
        let policy = |label: &Option<IntegrityLabel>| {
            label
                .as_ref()
                .map_or(DEFAULT_INTEGRITY_POLICY, |label| label.policy)
        };
        if policy(&self.label) != policy(&other.label) {
            return false;
        }
        // SAFETY: label SIDs were ACE-bounded and validated; snapshots own the
        // descriptors for the whole comparison. An absent label means medium.
        unsafe {
            match (&self.label, &other.label) {
                (None, None) => true,
                (Some(left), Some(right)) => EqualSid(left.sid, right.sid) != 0,
                (Some(label), None) | (None, Some(label)) => {
                    IsWellKnownSid(label.sid, WinMediumLabelSid) != 0
                }
            }
        }
    }

    fn acl(&self) -> Result<Option<&[u8]>> {
        if self.dacl.is_null() {
            return Ok(None);
        }
        // SAFETY: capture validated this Windows-owned ACL. AclSize bounds the
        // complete ACL in the still-live self-relative descriptor allocation.
        let length = unsafe { (*self.dacl).AclSize } as usize;
        if length < size_of::<ACL>() {
            return Err(changed());
        }
        Ok(Some(unsafe {
            std::slice::from_raw_parts(self.dacl.cast::<u8>(), length)
        }))
    }

    fn same_permissions(&self, other: &Self) -> Result<bool> {
        // SAFETY: both SIDs were validated and remain owned by live snapshots.
        Ok(self.present == other.present
            && self.protected == other.protected
            && self.same_integrity(other)
            && unsafe { EqualSid(self.owner, other.owner) } != 0
            && self.acl()? == other.acl()?)
    }

    fn is_effective_default_owner(&self) -> Result<bool> {
        let token = effective_token()?;
        if token_integrity_level(&token)? != 0x2000 {
            return Err(PortcoveError::unsupported(
                "settings editing requires an effective medium-integrity token",
            ));
        }
        let mut needed = 0;
        // SAFETY: the null/zero buffer asks only for the required output size.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle() as _,
                TokenOwner,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed < size_of::<TOKEN_OWNER>() as u32 || needed > 4096 {
            return Err(changed());
        }
        let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        // SAFETY: aligned initialized storage covers the requested size; the
        // token handle and storage remain live throughout SID comparison.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle() as _,
                TokenOwner,
                storage.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let owner = unsafe { (*storage.as_ptr().cast::<TOKEN_OWNER>()).Owner };
        if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
            return Err(changed());
        }
        Ok(unsafe { EqualSid(self.owner, owner) } != 0)
    }
}

impl HeldFile {
    pub(crate) fn require_editable_security(&self) -> Result<()> {
        validate_attributes(self.file.metadata()?.file_attributes())?;
        if self.file.metadata()?.permissions().readonly() {
            return Err(PortcoveError::unsupported(
                "read-only configuration files cannot be edited",
            ));
        }
        let security = SecuritySnapshot::capture(&self.file)?;
        // v1 never relabels replacements. Restrict both the original and the
        // stage's immediate parent to ordinary medium/default policy before
        // review succeeds or durable intent is inserted. The effective-token query
        // below likewise refuses elevated/low-integrity staging semantics.
        let parent = SecuritySnapshot::capture(self._parents.last().ok_or_else(changed)?)?;
        if !security.has_default_medium_integrity() || !parent.has_default_medium_integrity() {
            return Err(PortcoveError::unsupported(
                "configuration or parent has unsupported integrity security; editing requires medium/default policy",
            ));
        }
        if !security.present || !security.is_effective_default_owner()? {
            return Err(PortcoveError::unsupported(
                "configuration security or ownership is not supported for editing",
            ));
        }
        Ok(())
    }

    pub(crate) fn preserve_security_from(&self, original: &HeldFile) -> Result<()> {
        if !self.exclusive {
            return Err(changed());
        }
        original.require_editable_security()?;
        let source = SecuritySnapshot::capture(&original.file)?;
        let current = SecuritySnapshot::capture(&self.file)?;
        if !source.same_integrity(&current) {
            return Err(PortcoveError::unsupported(
                "configuration integrity labels differ; original policy was preserved",
            ));
        }
        if unsafe { EqualSid(source.owner, current.owner) } == 0 {
            return Err(changed());
        }
        if !source.same_permissions(&current)? {
            if self.file.metadata()?.len() != 0 {
                return Err(changed());
            }
            // A missing DACL is refused above; an intentional present NULL
            // DACL stays distinct from a present empty ACL. No owner or group
            // is reassigned and no token privilege is enabled.
            let flags = DACL_SECURITY_INFORMATION
                | if source.protected {
                    PROTECTED_DACL_SECURITY_INFORMATION
                } else {
                    UNPROTECTED_DACL_SECURITY_INFORMATION
                };
            // SAFETY: the stage is held share-exclusive with WRITE_DAC; source
            // owns the validated ACL for this entire synchronous API call.
            let result = unsafe {
                SetSecurityInfo(
                    self.file.as_raw_handle() as _,
                    SE_FILE_OBJECT,
                    flags,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    source.dacl,
                    std::ptr::null_mut(),
                )
            };
            if result != 0 {
                return Err(std::io::Error::from_raw_os_error(result as i32).into());
            }
        }
        if !source.same_permissions(&SecuritySnapshot::capture(&self.file)?)? {
            return Err(changed());
        }
        Ok(())
    }

    pub(crate) fn verify_security_matches(&self, original: &HeldFile) -> Result<()> {
        original.require_editable_security()?;
        if !SecuritySnapshot::capture(&original.file)?
            .same_permissions(&SecuritySnapshot::capture(&self.file)?)?
        {
            return Err(changed());
        }
        Ok(())
    }
}

fn validate_attributes(attributes: u32) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_ENCRYPTED;
    if attributes & FILE_ATTRIBUTE_ENCRYPTED != 0 {
        return Err(PortcoveError::unsupported(
            "EFS-encrypted configuration files cannot be edited",
        ));
    }
    Ok(())
}

// Thread-local medium-integrity fixture context. This lowers only an owned
// impersonation token; it retains the account's other capabilities and is NOT
// evidence of a nonadministrator account or a native game observation.
#[cfg(test)]
pub(crate) struct MediumIntegrityTest {
    _same_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(test)]
impl MediumIntegrityTest {
    pub(crate) fn enter() -> Self {
        use windows_sys::Win32::Security::{
            Authorization::ConvertStringSidToSidW, ImpersonateSelf, SID_AND_ATTRIBUTES,
            SecurityImpersonation, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
        };
        // Windows SDK SE_GROUP_INTEGRITY (SystemServices): a SID attribute,
        // kept local to this test fixture without widening production features.
        const SE_GROUP_INTEGRITY: u32 = 0x20;
        let mut existing = std::ptr::null_mut();
        // No borrowed impersonation state may be overwritten or reverted.
        let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut existing) };
        if opened != 0 {
            drop(unsafe { OwnedHandle::from_raw_handle(existing) });
            panic!("settings fixture refuses pre-existing thread impersonation");
        }
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(ERROR_NO_TOKEN as i32)
        );
        let before = token_integrity_level(&effective_token().unwrap()).unwrap();
        assert!(before >= 0x2000, "fixture must never raise integrity");
        // SAFETY: duplicates only our own process context onto this thread;
        // no privilege is enabled and no account or process token is changed.
        assert_ne!(unsafe { ImpersonateSelf(SecurityImpersonation) }, 0);
        // Establish rollback before any later fallible work.
        let scope = Self {
            _same_thread: std::marker::PhantomData,
        };
        let mut raw = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                OpenThreadToken(
                    GetCurrentThread(),
                    TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                    1,
                    &mut raw,
                )
            },
            0
        );
        let token = unsafe { OwnedHandle::from_raw_handle(raw) };
        let text: Vec<u16> = "S-1-16-8192".encode_utf16().chain(Some(0)).collect();
        let mut sid = std::ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) },
            0
        );
        struct Sid(PSID);
        impl Drop for Sid {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let sid = Sid(sid);
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: sid.0,
                Attributes: SE_GROUP_INTEGRITY,
            },
        };
        let length = size_of::<TOKEN_MANDATORY_LABEL>() as u32
            + unsafe { windows_sys::Win32::Security::GetLengthSid(sid.0) };
        assert_ne!(
            unsafe {
                SetTokenInformation(
                    token.as_raw_handle() as _,
                    TokenIntegrityLevel,
                    std::ptr::from_ref(&label).cast(),
                    length,
                )
            },
            0
        );
        assert_eq!(
            token_integrity_level(&effective_token().unwrap()).unwrap(),
            0x2000
        );
        scope
    }
}

#[cfg(test)]
impl Drop for MediumIntegrityTest {
    fn drop(&mut self) {
        // Never let leaked impersonation reach another case on this thread.
        if unsafe { windows_sys::Win32::Security::RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

#[cfg(test)]
impl HeldFile {
    pub(crate) fn set_no_read_up_for_test(path: &Path) -> Result<()> {
        Self::set_test_integrity(path, "S:(ML;;NWNR;;;LW)")
    }

    pub(crate) fn set_low_integrity_for_test(path: &Path) -> Result<()> {
        Self::set_test_integrity(path, "S:(ML;;NW;;;LW)")
    }

    fn set_test_integrity(path: &Path, label: &str) -> Result<()> {
        use windows_sys::Win32::{
            Security::Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            Storage::FileSystem::WRITE_OWNER,
        };
        struct Descriptor(PSECURITY_DESCRIPTOR);
        impl Drop for Descriptor {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | WRITE_OWNER)
            .share_mode(7)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        ordinary(&file, file.metadata()?.is_dir())?;
        let text: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
        let mut raw = std::ptr::null_mut();
        // SAFETY: fixed test SDDL and initialized output; no credentials or
        // privileges are created. The label is lowered on an owned temp file.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let descriptor = Descriptor(raw);
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorSacl(descriptor.0, &mut present, &mut acl, &mut defaulted)
        } == 0
            || present == 0
            || acl.is_null()
        {
            return Err(changed());
        }
        let result = unsafe {
            SetSecurityInfo(
                file.as_raw_handle() as _,
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                acl,
            )
        };
        if result != 0 {
            return Err(std::io::Error::from_raw_os_error(result as i32).into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };

    struct Sddl(PSECURITY_DESCRIPTOR);
    impl Drop for Sddl {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn set_acl(file: &File, text: &str, protected: bool) {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: static test SDDL is NUL-terminated; initialized output owns
        // the descriptor allocated by this successful Windows API call.
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let descriptor = Sddl(descriptor);
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted)
            },
            0
        );
        assert_ne!(present, 0);
        let flags = DACL_SECURITY_INFORMATION
            | if protected {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    file.as_raw_handle() as _,
                    SE_FILE_OBJECT,
                    flags,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null_mut(),
                )
            },
            0
        );
    }

    #[test]
    fn medium_fixture_is_thread_local_refuses_borrowed_context_and_reverts() {
        let before = token_integrity_level(&effective_token().unwrap()).unwrap();
        {
            let _integrity = MediumIntegrityTest::enter();
            assert_eq!(
                token_integrity_level(&effective_token().unwrap()).unwrap(),
                0x2000
            );
            assert!(std::panic::catch_unwind(MediumIntegrityTest::enter).is_err());
            assert_eq!(
                token_integrity_level(&effective_token().unwrap()).unwrap(),
                0x2000
            );
            // Another thread retains the process context; the fixture does not
            // alter primary-token state or lower a shared test process.
            assert_eq!(
                std::thread::spawn(|| token_integrity_level(&effective_token().unwrap()).unwrap())
                    .join()
                    .unwrap(),
                before
            );
        }
        assert_eq!(
            token_integrity_level(&effective_token().unwrap()).unwrap(),
            before
        );
        let mut raw = std::ptr::null_mut();
        assert_eq!(
            unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) },
            0
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(ERROR_NO_TOKEN as i32)
        );
    }

    #[test]
    fn permissive_parent_cannot_expose_staged_bytes_before_restricted_dacl_is_preserved() {
        let _integrity = MediumIntegrityTest::enter();
        let temporary = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temporary.path()).unwrap();
        let parent = root.join("permissive");
        std::fs::create_dir(&parent).unwrap();
        let directory = OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | WRITE_DAC)
            .share_mode(7)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&parent)
            .unwrap();
        set_acl(&directory, "D:P(A;OICI;FA;;;WD)", true);
        drop(directory);
        let original_path = parent.join("prefs.ini");
        std::fs::write(&original_path, b"private original").unwrap();
        let configure = OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_DAC)
            .share_mode(7)
            .open(&original_path)
            .unwrap();
        set_acl(&configure, "D:P(A;;FA;;;OW)", true);
        drop(configure);
        let original = HeldFile::open(&original_path).unwrap();
        original.require_editable_security().unwrap();
        let before = SecuritySnapshot::capture(&original.file).unwrap();
        assert!(before.protected);
        let new_path = parent.join("owned.new");
        let mut stage = HeldFile::create_stage(&new_path).unwrap();
        // Creation itself is share-exclusive, so no reader can retain a
        // permissive-parent read handle before the DACL is tightened.
        assert!(File::open(&new_path).is_err());
        stage.preserve_security_from(&original).unwrap();
        assert!(
            before
                .same_permissions(&SecuritySnapshot::capture(&stage.file).unwrap())
                .unwrap()
        );
        stage
            .fill_stage(b"reviewed private postimage", &|_| Ok(()))
            .unwrap();
        assert!(File::open(&new_path).is_err());
        let published = parent.join("published.ini");
        stage.move_to(&published).unwrap();
        assert!(
            before
                .same_permissions(&SecuritySnapshot::capture(&stage.file).unwrap())
                .unwrap()
        );
        drop(stage);
        let published_handle = File::open(&published).unwrap();
        assert!(
            before
                .same_permissions(&SecuritySnapshot::capture(&published_handle).unwrap())
                .unwrap()
        );
        assert_eq!(std::fs::read(&original_path).unwrap(), b"private original");
    }

    #[test]
    fn foreign_nonempty_staging_security_is_not_rewritten_to_match_original() {
        let _integrity = MediumIntegrityTest::enter();
        let temporary = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temporary.path()).unwrap();
        let original_path = root.join("prefs.ini");
        std::fs::write(&original_path, b"original usable data").unwrap();
        let configure = OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | WRITE_DAC)
            .share_mode(7)
            .open(&original_path)
            .unwrap();
        set_acl(&configure, "D:P(A;;FA;;;OW)", true);
        drop(configure);
        let original = HeldFile::open(&original_path).unwrap();
        let mut stage = HeldFile::create_stage(&root.join("unknown.new")).unwrap();
        stage
            .fill_stage(b"existing different content", &|_| Ok(()))
            .unwrap();
        assert!(stage.preserve_security_from(&original).is_err());
        assert_eq!(stage.bytes(1024).unwrap(), b"existing different content");
        assert_eq!(
            std::fs::read(&original_path).unwrap(),
            b"original usable data"
        );
    }

    #[test]
    fn captured_null_and_empty_dacls_remain_distinct() {
        let _integrity = MediumIntegrityTest::enter();
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("acl.ini");
        std::fs::write(&path, b"inert").unwrap();
        let handle = OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | WRITE_DAC)
            .share_mode(7)
            .open(&path)
            .unwrap();
        set_acl(&handle, "D:P", true);
        let empty = SecuritySnapshot::capture(&handle).unwrap();
        assert!(empty.present);
        assert!(empty.acl().unwrap().is_some());
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    handle.as_raw_handle() as _,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let null = SecuritySnapshot::capture(&handle).unwrap();
        assert!(null.present);
        assert!(null.acl().unwrap().is_none());
        assert!(!empty.same_permissions(&null).unwrap());
    }

    #[test]
    fn encrypted_attribute_is_refused_without_creating_efs_keys_or_files() {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_ENCRYPTED,
        };
        assert!(validate_attributes(FILE_ATTRIBUTE_ARCHIVE).is_ok());
        let error =
            validate_attributes(FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_ENCRYPTED).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(error.message.contains("EFS"));
    }
}
