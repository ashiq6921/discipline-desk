# Discipline Desk (published site)

The web app behind a private trading journal. This repository only holds the published files, copied from a private project.
It contains no trading data: everything is stored in a private database behind a login, and public sign-ups are switched off.

- `public/` is what GitHub Pages serves.
- `scripts/fetch_calendar.py` and `.github/workflows/site.yml` refresh the economic-calendar data every hour.
- Third-party libraries are in `public/vendor/` (see its README for versions and licences).

Do not edit files here by hand. They are overwritten by the next publish.
