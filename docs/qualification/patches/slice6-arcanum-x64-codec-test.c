/* Portcove fixture for the selected Windows x64 Arcanum source treatment.
 * Compile with the selected source's bink_compat include/src directories.
 * A local probe replaces DLL loading; this fixture never loads a codec or game.
 */
#if !defined(_WIN32) || !defined(_WIN64)
#error This fixture requires a native Windows x64 compilation.
#endif
#define WIN32_LEAN_AND_MEAN 1
#include <windows.h>
#include <stdio.h>

static unsigned int codec_load_attempts;
HMODULE WINAPI codec_probe_load(LPCSTR name)
{
    (void)name;
    codec_load_attempts++;
    return NULL;
}

/* Include the real selected implementation, rather than mirroring its guards. */
#define LoadLibraryA codec_probe_load
#include "bink_compat.c"
#undef LoadLibraryA

int main(void)
{
    if (sizeof(void*) != 8 || bink_compat_init() || codec_load_attempts != 0) {
        fputs("FAIL: x64 codec initialization attempted ambient loading\n", stderr);
        return 1;
    }
    if (BinkOpen("fixture-never-opened.bik", 0) != NULL
        || BinkOpenMiles(NULL) != NULL
        || BinkCopyToBuffer(NULL, NULL, 0, 0, 0, 0, 0) != -1
        || BinkDDSurfaceType(NULL) != -1
        || BinkDoFrame(NULL) != -1
        || BinkSetSoundSystem(NULL, NULL) != -1
        || BinkWait(NULL) != -1) {
        fputs("FAIL: unavailable-codec fallback changed\n", stderr);
        return 2;
    }
    BinkClose(NULL);
    BinkNextFrame(NULL);
    BinkSetSoundTrack(0);
    bink_compat_exit();
    if (codec_load_attempts != 0) return 3;
    puts("PASS: unavailable x64 codec; zero ambient load attempts");
    return 0;
}
