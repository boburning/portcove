# Reviewed package layouts for JGR Patch Pack and OpenGlad

These five managed routes consume the package-layout gate from
[#4871](https://github.com/boburning/portcove/pull/4871) for
[#4780](https://github.com/boburning/portcove/issues/4780).
The reviewed assets in each row agree on top-level directories and program
paths. Asset sizes and SHA-256 values matched the publisher's release metadata.

| Route                         | Earlier asset ID | Successor asset ID | Directories | Program paths |
| ----------------------------- | ---------------- | ------------------ | ----------- | ------------- |
| JGR Patch Pack Windows x86-64 | 634503612        | 698301973          | 6           | 1             |
| JGR Patch Pack Linux x86-64   | 634550225        | 698299976          | 8           | 1             |
| OpenGlad Windows x86-64       | 695939039        | 726512797          | 5           | 2             |
| OpenGlad Linux x86-64         | 695939042        | 726512799          | 5           | 18            |
| OpenGlad Apple Silicon        | 695939035        | 726512796          | 5           | 18            |

JGR pairs [0.73.4](https://github.com/JGRennison/OpenTTD-patches/releases/tag/jgrpp-0.73.4)
with [0.73.5](https://github.com/JGRennison/OpenTTD-patches/releases/tag/jgrpp-0.73.5).
OpenGlad pairs [v2.1097](https://github.com/openglad/openglad/releases/tag/v2.1097)
with [v2.1098](https://github.com/openglad/openglad/releases/tag/v2.1098).
The OpenGlad Unix paths include WAV files carrying executable mode in both
packages. They are part of the current gate's observable inventory, so a
future release changing those modes can require review. The JGR Linux
observation accounts for the copy semantics of its in-archive aliases.

The gate applies to fresh staging under these definitions. The original
input rules, existing runtime ownership, persistent paths and creating
definitions keep their scope. The compared archives support the layout
expectation only. No upstream code or game was run, and the comparison
does not establish save compatibility or protected publication.
