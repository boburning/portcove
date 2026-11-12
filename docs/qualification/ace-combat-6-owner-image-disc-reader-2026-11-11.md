# Ace Combat 6 owner-image disc reader observation

One Xbox 360 disc image of Ace Combat 6: Fires of Liberation (USA, Japan),
provided by the project owner from their own collection, was read with Portcove's
managed disc-image reader and with an independent standalone parser. This record
states what those local observations established about that one image. It does
not qualify the game, the upstream runtime or Portcove's managed route.

## Image identity

| Fact                          | Observation                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| Image size                    | 7,835,492,352 bytes                                                |
| File system                   | XDVDFS (Xbox 360 game partition), one volume descriptor            |
| Volume descriptor offset      | `0x0FD90000` (the XGD2 layout offset)                              |
| Directory contents            | 13 files in 1 directory                                            |
| Total file bytes              | 5,443,410,412                                                      |
| `default.xex` size            | 7,483,392 bytes                                                    |
| `default.xex` SHA-256         | `6eefba42cdfe9121207e534d8d290009c98b1a8c60ae5334a33a4f15167cbbbc` |
| Title ID (XEX execution info) | `4E4D07D1`                                                         |
| Whole-image SHA-1             | `fc0796fa56149e35a50d49205233a8cc06e13f03`                         |
| Whole-image SHA-256           | `204c5e645d79da8776699c12f17bd069f869fbdb10ae79015d1a0ef2b743c98c` |

The title ID is the eight-digit hexadecimal value in the execution-information
header of `default.xex`. Portcove reports it as eight uppercase digits.

## Method

The image was read only. It was never modified, trimmed or rebuilt.

1. A standalone XDVDFS parser written from the public format description probed
   the four known partition offsets, accepted exactly one volume descriptor,
   walked the directory tree, and reported the counts and sizes above. It read
   `default.xex` to report its SHA-256 and title ID.
2. Portcove's disc-image reader planned the same image, read the product code
   from `default.xex`, and extracted the whole tree into a new scratch folder.
3. Both routes agreed on the descriptor offset, file and directory counts, total
   file bytes and title ID. The extracted tree contained the same 13 files and
   the same total bytes, and its `default.xex` had the SHA-256 above. The full
   extraction took about two minutes on a Windows-mounted scratch drive from a
   Linux development host.
4. The whole-image SHA-1 and SHA-256 were computed over the complete image file.

## What this supports

- The anchor file `default.xex` with the SHA-256 above, and the title ID
  `4E4D07D1`, identify this image to Portcove's managed unpacking.
- The whole-image SHA-1 and SHA-256 above identify this exact image as an
  accepted source. A definition may accept only these identities from this
  record.

## What this does not establish

- It is one local observation of one image on a development host. It is not an
  installed-application, physical-media or console observation.
- Other editions, regions, revisions and re-dumps of the game are not verified.
  The accepted image is the combined USA and Japan release only; the catalog
  entry keeps its statement that Europe and Japan are not supported.
- The whole-image hashes were not compared with a disc-database entry, so no
  external authority for the image is claimed.
- The upstream runtime was not started, so nothing here concerns playback,
  rendering, saves, updates or rollback. Gameplay and minimum-system
  observations remain unqualified, and this record promotes nothing to Supported.
