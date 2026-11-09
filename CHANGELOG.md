# Time Tracker Pro changes

## 1.4.0 — local installer candidate, 2026-11-09

Prepared for the owner's installation and testing. Publication follows only after that testing succeeds.

- Replaced Dashboard with Today: active timer controls, session timeline, recurring goals, goal journeys, and upcoming trackers.
- Added Trackers for countdowns, consumable lifetimes, and days since recurring tasks. Includes cycle history and editing, costs, renew/finish/done actions, undo, archive, search/filter, timeline/table views, and reorderable cards with saved preferences.
- Added long-term goal journeys with a counting start date, milestones, recent pace, estimated completion, and a pace needed for an optional deadline.
- Added local rotating diagnostic logs to investigate unexpected alert sounds. Tracks timer state transitions, whether completion produced a session, caller sources, sound play/stop causes, window IDs/visibility, and Electron sleep/resume reports. Diagnostic failures do not interrupt timers or sound handling. No note text is written to the event log.
- Included the previously committed fixes for the Pomodoro long-break fallback and No category timer duration. Number inputs select their existing value when focused.
- Excluded local video notes from installer packaging. Personal data, session memory, scratch plans, and tests remain excluded.
- Added automated diagnostics tests and documented the manual installation/release checks in RELEASE_GUIDE.md.

The earlier Today/Trackers work was already present locally when this release preparation started; this entry records its inclusion in the installer, without inventing dates for its individual changes.

## 1.3.0 — 2026-11-06

- Added a Stop sound bar so an alert can be silenced without starting another session.
- Stopped timers save elapsed time; sessions below one minute are skipped with an explanation.
- Manual logging uses Started at and Finished at fields to calculate duration.
- Session pauses are saved, shown in the Log, and left as gaps on the dashboard timeline.

Earlier public versions and implementation details are available in Git history. Local project memory under `sessions/` contains the more detailed development record; that folder is intentionally excluded from Git and installers.
