# Local installer testing and GitHub Releases

## Current handoff

Version 1.4.0 contains Today, Trackers, goal journeys, and diagnostic event logging. The owner will install the Windows .exe and confirm that it works before any push/tag or GitHub publication. No installation or publication is performed by the build step.

`CHANGELOG.md` records changes by version. `RELEASE_NOTES.md` is the text used for the next GitHub release. Local `sessions/CONTINUE.md` and `sessions/SUMMARY_2026-11-09.md` record validation and the next action.

## Test on the owner's PC first

1. Quit the currently running app through its tray menu and stop any development server on port 3000.
2. Run `dist/Time-Tracker-Pro-Setup-1.4.0.exe`. Keep the existing installation location when upgrading. The installer still has its folder chooser.
3. Open Time Tracker Pro from its shortcut, without a terminal. Check that the sidebar version says v1.4.0 and that the existing categories, session history, goals, sounds, and settings remain available.
4. Check Today: totals/timeline, recurring goals, a total-hours goal journey, and timer pause/resume/stop controls. Goals without a counting start date continue to count all their sessions.
5. Check Trackers: create a tracker of each kind; try its action, cycle details/history, layouts, search, and archive. Quit and reopen to confirm saved trackers/preferences remain. The new tracker file starts empty on an existing install; development data is not copied into the installed app.
6. Finish a one-minute timer, hear the alert, and click Stop sound. Open `events.log` in the installed app's data folder and confirm `timer:finished`, `sound:play`, and `sound:stop`. A Pomodoro break should say `logged=no`. Test the tray shortcut and sleep/resume when convenient.
7. If using Stream Dock, its installed plugin must be refreshed with the source `stream-dock-plugin/setup.js` and Stream Dock restarted before presses carry `src=streamdock`. This is separate from installing the app. An older plugin still works but its presses may be labeled browser/other.
8. Report whether the checks passed. If something fails, fix it and rebuild before publishing. If the unexpected sound recurs, record its time and inspect nearby diagnostic lines before changing sound behavior.

The installed data folder is `%APPDATA%\Time Tracker Pro\data`; source runs use `Schedule/data`. Electron selects the installed path through `app.getPath('userData')`. Log files rotate at 1 MB into `events.old.log`. Charts, icons, drag support, and fonts still use public CDNs.

## Build and verify locally

```powershell
npm test
npm run build -- --publish never
node scripts/verify-release.js
```

Both package.json and package-lock.json must carry the same version. Keep `asar: true`, the application ID, port 3000, the data directory rules, and the installer folder chooser.

For Windows, keep these matching files together:

- `Time-Tracker-Pro-Setup-1.4.0.exe`
- `Time-Tracker-Pro-Setup-1.4.0.exe.blockmap`
- `latest.yml`

The executable's size and SHA-512 must match `latest.yml`. Its packaged `resources/app.asar` must contain `public/js/trackers.js`, `public/js/journey.js`, `defaults/trackers.json`, and the diagnostic hooks. It must exclude personal `data/`, `.tmp/`, `sessions/`, `plans/`, local video notes, and test scripts.

## Publish only after the owner confirms the installed build

These steps describe this repository's checked-in `.github/workflows/linux.yml`; review the live workflow/release status before carrying them out.

1. Review the local release commit and merge the feature branch into `main`. Preserve the tested source when merging. If code changes during the merge, repeat the relevant checks and rebuild the Windows files.
2. Push `main`. The existing workflow runs a Linux build for main pushes; it does not create a release for a branch push.
3. Create and push the tag `v1.4.0` on the release commit. Do not move an existing published tag.
4. The tag workflow builds the Ubuntu `.deb`, installs/starts it as a check, and creates or fills a **draft** GitHub Release with the `.deb` and `latest-linux.yml`.
5. Wait for that workflow to pass. Open the draft release and upload the three Windows files listed above from this same tested build.
6. Confirm the draft has all five assets: Windows installer, blockmap, latest.yml, Ubuntu .deb, latest-linux.yml. Confirm the tag/version and release notes.
7. Publish the draft. GitHub Releases is the update source; pushing code alone does not update installed apps. The apps only see a published release and still require a click to download and another click to install.

The owner handles publication with guidance after local testing. This document is a checklist, not authorization to publish.
