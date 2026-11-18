#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
static inline int portcove_snapshot_kind(const char *path) {
    struct stat value;
    if (lstat(path, &value) != 0) return -1;
    if (S_ISREG(value.st_mode)) return 1;
    if (S_ISDIR(value.st_mode)) return 2;
    if (S_ISLNK(value.st_mode)) return 3;
    return 0;
}
