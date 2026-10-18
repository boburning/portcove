#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <stdio.h>
#include <string>
#include <string.h>
#include <vector>

static bool bounded_fill(const std::wstring& root) {
    ULARGE_INTEGER available,total,free;
    if (!GetDiskFreeSpaceExW(root.c_str(),&available,&total,&free) || total.QuadPart == 0 || total.QuadPart > 536870912ULL) return false;
    const std::wstring name=root+L"\\quota-fill.data";
    HANDLE file=CreateFileW(name.c_str(),GENERIC_WRITE|GENERIC_READ,FILE_SHARE_READ,nullptr,CREATE_NEW,0,nullptr);
    if(file==INVALID_HANDLE_VALUE)return false;
    const DWORD attributes=GetFileAttributesW(name.c_str());
    if(attributes==INVALID_FILE_ATTRIBUTES || (attributes&(FILE_ATTRIBUTE_SPARSE_FILE|FILE_ATTRIBUTE_COMPRESSED))!=0){CloseHandle(file);return false;}
    printf("{\"phase\":\"bounded-fill-started\",\"volume_bytes\":%llu}\n",total.QuadPart);fflush(stdout);
    std::vector<BYTE> block(1024*1024,0xA5);DWORD failure=0;ULONGLONG completed=0;
    for(int i=0;i<513;i++) {
        DWORD written=0;
        const BOOL success=WriteFile(file,block.data(),static_cast<DWORD>(block.size()),&written,nullptr);
        completed+=written;
        if(!success){failure=GetLastError();break;}
        if(written!=block.size()){failure=ERROR_WRITE_FAULT;break;}
    }
    LARGE_INTEGER size;const bool observed=GetFileSizeEx(file,&size)!=0;
    const bool flushed=FlushFileBuffers(file)!=0;CloseHandle(file);
    printf("{\"phase\":\"bounded-fill-refusal\",\"write_error\":%lu,\"completed_bytes\":%llu,\"size_observed\":%s,\"observed_size\":%llu,\"flush_succeeded\":%s,\"file_retained\":true,\"subsequent_attempts\":0}\n",failure,completed,observed?"true":"false",observed?static_cast<ULONGLONG>(size.QuadPart):0,flushed?"true":"false");
    return (failure==ERROR_DISK_FULL || failure==ERROR_HANDLE_DISK_FULL) && observed && size.QuadPart>0 && static_cast<ULONGLONG>(size.QuadPart)<=total.QuadPart;
}

static bool read_input(const std::wstring& name) {
    HANDLE file = CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    char bytes[32]; DWORD size = 0;
    const bool result = ReadFile(file, bytes, sizeof(bytes), &size, nullptr) && size == 14 &&
        memcmp(bytes, "frozen inputs\n", 14) == 0;
    CloseHandle(file); return result;
}

static bool read_denied(const std::wstring& name) {
    HANDLE file = CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); return false; }
    return GetLastError() == ERROR_ACCESS_DENIED;
}
static bool write_denied(const std::wstring& name) {
    HANDLE file = CreateFileW(name.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr);
    const DWORD error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    printf("{\"write_probe_opened\":%s,\"write_probe_error\":%lu}\n",file!=INVALID_HANDLE_VALUE?"true":"false",error);
    if (file != INVALID_HANDLE_VALUE) {
        wchar_t final_path[32768];const DWORD count=GetFinalPathNameByHandleW(file,final_path,32768,0);
        if(count>0 && count<32768)printf("write_probe_final_path=%ls\n",final_path);
    }
    if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); return false; }
    return error == ERROR_ACCESS_DENIED;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const std::wstring root(argv[1]);
    wchar_t profile[32768], temp[32768];
    wchar_t bounded_data[32768];
    const bool bounded=GetEnvironmentVariableW(L"PORTCOVE_REVIEW_BOUNDED_DATA",bounded_data,32768)>0;
    if (!GetEnvironmentVariableW(L"PORTCOVE_REVIEW_PROFILE", profile, 32768) ||
        !GetEnvironmentVariableW(L"TEMP", temp, 32768)) return 2;
    printf("probe_profile_path=%ls\nprobe_temp_path=%ls\n",profile,temp);
    const bool input_read = read_input(root + L"\\inputs\\frozen.txt");
    const bool work_write = write_denied(root + L"\\work\\native-created.data");
    const bool temp_write = write_denied(std::wstring(temp) + L"\\native-temp.data");
    const bool profile_write = write_denied(std::wstring(profile) + L"\\native-profile.data");
    const bool issuer_read = read_denied(root + L"\\sensitive\\issuer.inert");
    const bool capture_write = write_denied(root + L"\\capture\\native-forged.data");
    const bool broad_read = read_denied(root + L"\\inputs\\allapps-only.txt");
    // Attempt a DACL self-regrant through the owner's implicit WRITE_DAC.
    SECURITY_DESCRIPTOR descriptor;
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, nullptr, FALSE)) return 2;
    const bool dacl_denied = !SetFileSecurityW((root + L"\\inputs\\frozen.txt").c_str(),
        DACL_SECURITY_INFORMATION, &descriptor) && GetLastError() == ERROR_ACCESS_DENIED;
    HANDLE token=nullptr; BYTE token_bytes[1024]; DWORD token_size=0;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token) ||
        !GetTokenInformation(token,TokenUser,token_bytes,sizeof(token_bytes),&token_size)) return 2;
    CloseHandle(token);
    SECURITY_DESCRIPTOR owner_descriptor;
    if (!InitializeSecurityDescriptor(&owner_descriptor,SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&owner_descriptor,reinterpret_cast<TOKEN_USER*>(token_bytes)->User.Sid,FALSE)) return 2;
    const bool owner_denied = !SetFileSecurityW((root + L"\\inputs\\frozen.txt").c_str(),OWNER_SECURITY_INFORMATION,&owner_descriptor) && GetLastError() == ERROR_ACCESS_DENIED;
    const HMODULE userenv = LoadLibraryExW(L"userenv.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    typedef HRESULT (WINAPI *RegistryLocation)(REGSAM, HKEY*);
    const auto registry_location = userenv ? reinterpret_cast<RegistryLocation>(GetProcAddress(userenv, "GetAppContainerRegistryLocation")) : nullptr;
    if (!registry_location) return 2;
    HKEY key = nullptr;
    const HRESULT read_status = registry_location(KEY_READ, &key);
    if (SUCCEEDED(read_status)) RegCloseKey(key);
    key = nullptr;
    bool rights[5] = {};
    const REGSAM requested[] = {KEY_SET_VALUE, KEY_CREATE_SUB_KEY, WRITE_DAC, WRITE_OWNER, DELETE};
    for (int i=0;i<5;i++) {
        const HRESULT status = registry_location(requested[i], &key);
        rights[i] = status == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
        if (SUCCEEDED(status)) RegCloseKey(key);
        key = nullptr;
    }
    const bool registry_read = SUCCEEDED(read_status);
    const bool registry_write = rights[0] && rights[1] && rights[2] && rights[3] && rights[4];
    key = nullptr;
    if (FAILED(registry_location(KEY_READ, &key))) return 2;
    DWORD new_value=456;
    const bool value_mutation = RegSetValueExW(key,L"PortcoveReadOnlyValue",0,REG_DWORD,reinterpret_cast<const BYTE*>(&new_value),sizeof(new_value)) == ERROR_ACCESS_DENIED;
    HKEY created=nullptr; DWORD disposition=0;
    const bool key_mutation = RegCreateKeyExW(key,L"PortcoveNewKey",0,nullptr,0,KEY_READ,nullptr,&created,&disposition) == ERROR_ACCESS_DENIED;
    if(created)RegCloseKey(created);
    const bool delete_mutation = RegDeleteKeyW(key,L"PortcoveReadOnlyCanary") == ERROR_ACCESS_DENIED;
    const bool registry_dacl_mutation = RegSetKeySecurity(key,DACL_SECURITY_INFORMATION,&descriptor) == ERROR_ACCESS_DENIED;
    const bool registry_owner_mutation = RegSetKeySecurity(key,OWNER_SECURITY_INFORMATION,&owner_descriptor) == ERROR_ACCESS_DENIED;
    RegCloseKey(key);
    printf("{\"registry_value_mutation_denied\":%s,\"registry_subkey_mutation_denied\":%s,\"registry_delete_mutation_denied\":%s,\"registry_dacl_mutation_denied\":%s}\n",value_mutation?"true":"false",key_mutation?"true":"false",delete_mutation?"true":"false",registry_dacl_mutation?"true":"false");
    printf("{\"file_owner_mutation_denied\":%s,\"registry_owner_mutation_denied\":%s}\n",owner_denied?"true":"false",registry_owner_mutation?"true":"false");
    printf("{\"registry_set_value_denied\":%s,\"registry_create_subkey_denied\":%s,\"registry_dacl_denied\":%s,\"registry_owner_denied\":%s,\"registry_delete_denied\":%s}\n",rights[0]?"true":"false",rights[1]?"true":"false",rights[2]?"true":"false",rights[3]?"true":"false",rights[4]?"true":"false");
    printf("{\"input_read\":%s,\"work_write_denied\":%s,\"temp_write_denied\":%s,\"real_profile_write_denied\":%s,\"issuer_read_denied\":%s,\"capture_write_denied\":%s,\"allapps_read_denied\":%s,\"owner_dacl_regrant_denied\":%s,\"registry_read\":%s,\"registry_write_denied\":%s}\n",
        input_read?"true":"false",work_write?"true":"false",temp_write?"true":"false",profile_write?"true":"false",
        issuer_read?"true":"false",capture_write?"true":"false",broad_read?"true":"false",dacl_denied?"true":"false",
        registry_read?"true":"false",registry_write?"true":"false");
    FreeLibrary(userenv);
    const bool safe=input_read && work_write && (bounded?!temp_write:temp_write) && profile_write && issuer_read && capture_write && broad_read && dacl_denied && owner_denied && registry_read && registry_write && value_mutation && key_mutation && delete_mutation && registry_dacl_mutation && registry_owner_mutation;
    if(!safe)return 1;
    return !bounded || bounded_fill(bounded_data) ? 0 : 1;
}
