# Use one ScummVM installation for several games

ScummVM keeps a saved target for each game you add. Portcove can save a library
entry for each target while both entries use the same ScummVM executable and
profile.

## Add the game files once

1. Get ScummVM from the [upstream downloads page](https://www.scummvm.org/downloads/).
   Windows can use the 64-bit ZIP. On Linux, install your distribution's package.
   On macOS, use the universal disk image for Intel or Apple Silicon.
2. Get a supported edition of your game. The [upstream games page](https://www.scummvm.org/games/)
   provides the freeware floppy editions of Beneath a Steel Sky and Flight of
   the Amazon Queen. Extract the game ZIP to its own folder. For Flight of the
   Amazon Queen, use the extracted `FOTAQ_Floppy` folder.
3. Open ScummVM, select **Add Game**, and choose the folder with the game data.
   Choose your edition or language if ScummVM asks. Repeat this step for each
   game you want.
4. Read the saved target ID in **Game Options**, or run `scummvm --list-targets`
   with the same configuration. A fresh profile often uses `sky` and `queen`
   for these examples. Use the ID shown in your profile.

## Save a Play entry in Portcove

Use a Portcove catalog that contains these ScummVM games. On Desktop, open the
game in Discover and choose **Use an existing
installation**. Select the native ScummVM executable and its parent folder as
the working directory. Enter the saved target ID as one argument. Review and
save the selection, then choose **Play**. Add a second game using the same
executable and the second game's target ID.

This is the equivalent PowerShell example for a default ScummVM profile. Set
the paths and target to match your own setup.

```powershell
$library = 'C:\Portcove Library'
$exe = 'C:\Portable Games\ScummVM\scummvm.exe'
$workingDirectory = Split-Path -Parent $exe
$port = 'scummvm-sky-sky'
$target = 'sky'
$selection = @($port, $exe, '--working-directory', $workingDirectory, "--arg=$target")

$review = portcove --library $library --json external select-preview @selection | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$review.ok) { throw 'Review the Portcove error before continuing.' }
$review.data
```

Once you have reviewed the executable, working directory and arguments, save
the selection using the same values.

```powershell
portcove --library $library external select @selection --expected-preview $review.data.preview_sha256 --yes
portcove --library $library exec $port
```

On Linux, use the native executable installed by your distribution. On macOS,
use `Contents/MacOS/scummvm` inside `ScummVM.app`. The same Portcove commands
apply. If you use a custom ScummVM profile, pass
`--arg=--config=<absolute profile path>` as one argument before the target ID.
Use exactly the same argument in both review and registration. Open the same
profile when changing settings in ScummVM's **Game Options**. Other frontends
can use the registered entry through `exec`. On Windows or Linux Desktop, use
the [manual Steam shortcut fields](manual-desktop-steam.md#add-one-already-installed-game).

## Keep saves when updating or removing a Play entry

Open **Game Options**, then **Paths**, and check **Save Path**. If it uses the
default, check **Global Options**, then [ScummVM's default save locations](https://docs.scummvm.org/en/latest/use_scummvm/save_load_games.html#location-of-saved-game-files).
**Global Options → Paths** also shows the active configuration file. Copy the
actual save folder and configuration with ScummVM closed. Keep the game data
where the profile expects it.

For the Windows ZIP, you replace the player. The Linux distribution package
updates through the package manager. The official universal macOS package has
ScummVM's updater. Close every game using the shared player before replacing it.
If the executable path, working directory or arguments change, use Portcove's
existing installation relink review. Removing one Portcove registration leaves the
shared player, other registrations, configuration, game data and saves in place.
Backups and restore of these external files remain with you.
