# Daggerfall Unity mod fixtures

The files are the unchanged .dfmod members of the cited upstream release
archives. The MIT license notices accompany the fixtures. Tests inspect the
files without loading them into Unity.

| Fixture | Source tag commit | Upstream release asset ID | .dfmod SHA-256 |
| --- | --- | --- | --- |
| PointyCursor Linux | f7633be3c230e80b159acda73cdcd68117ad4dfa | 238015765 | f6f35897159bcc124ed8501d0aef0d87b3269d258abce28420f924610e1a639b |
| PointyCursor Windows | f7633be3c230e80b159acda73cdcd68117ad4dfa | 238015773 | 48b89f2092725205a43b8dfe1c8714384ce9385929feac43c49f17409574c7de |
| EasyNPCBehavior Linux | 8fc29e0770852c55f1906c8d36a287c922e023fe | 259784800 | 9937b5af331738b1c8fa299a22dde1befe038e44344fcb4dcc1080546c31fe1d |

PointyCursor has one texture and its manifest. The manifest declares no
mandatory dependency. Each payload matches its tagged Git object.
[PointyCursor source](https://github.com/ArshvirGoraya/WandererHud/tree/f7633be3c230e80b159acda73cdcd68117ad4dfa/SubModules/PointyCursor)
· [Published ZIPs](https://github.com/ArshvirGoraya/WandererHud/releases/tag/1.0.0)

EasyNPCBehavior contains C# source alongside its manifest and settings.
The publisher's ZIP digest was verified before isolating this member.
[EasyNPCBehavior source](https://github.com/BigDeal0716/Easy-NPC-Behavior/tree/8fc29e0770852c55f1906c8d36a287c922e023fe)
· [Published ZIPs](https://github.com/BigDeal0716/Easy-NPC-Behavior/releases/tag/v1.0.0tr)
