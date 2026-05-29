# Campus Week Planner

A small English-only timetable builder for college students. It creates a Monday-Friday weekly schedule, checks overlapping items, saves data in the browser, and can auto-place study blocks into open weekday gaps. The built-in USC picker uses Fall 2026 course data from the USC Schedule of Classes.

## Open

Run the local server so USC major and course data can refresh from the USC Schedule of Classes API:

```bash
npm start
```

Then visit:

```text
http://localhost:4173/
```

## Deploy On Render

This project is ready for a Render Web Service deployment.

1. Push this folder to a GitHub repository.
2. In Render, choose New > Web Service.
3. Connect the GitHub repository.
4. Use these settings:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
5. Create the service.

Render will provide an HTTPS `onrender.com` URL after the first deploy. The included `render.yaml` can also be used as a Render Blueprint.

## Current Features

- Monday-Friday timetable from 8:00 AM to 10:00 PM
- Add lectures, labs, seminars, study blocks, work, and personal activities
- Select any USC Fall 2026 major, course, and scheduled section without typing the title manually
- Add USC section meetings with section number, time, and instructor details
- Expanded pastel color palette for schedule items
- Multi-day recurring entries
- Edit or delete grouped entries
- Automatic study block planning
- Conflict warnings
- Browser storage
- Save and load timetable JSON files
- One-page print layout
- PNG timetable export
- Responsive layout for desktop and mobile

## USC Data

USC Fall 2026 major and section data is stored in `usc-programs.js` and `usc-data/20263/`. The Node server refreshes the major list when the app loads and refreshes a selected major's course data when that major is opened. Regenerate the full local cache with:

```bash
node scripts/generate-usc-data.mjs
```

## Good Next Decisions

- Whether the planner should support weekend schedules later
- Whether each course should have a target number of weekly study hours
- Whether auto-planning should prefer mornings, afternoons, or empty days
- Whether meals, commute time, and sleep should be fixed defaults
- Whether the timetable should export to Google Calendar or Apple Calendar
- Whether USC course sections should also include building and room data when USC exposes it
