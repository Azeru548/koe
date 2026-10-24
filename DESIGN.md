# Koe design system

Koe should feel like a working script on a desk, not a dashboard. The script is
the largest object; the voice is casting; each generation is a take. The
operator analytics page extends that same world with a ledger, not a second
product.

## World

- **Paper:** `#f2f0e9` page, `#fbfaf5` sheet, `#f6f3ea` secondary sheet.
- **Ink:** `#181613` primary, `#3b372f` body, `#6d675c` muted, `#736c5f` faint.
- **Line:** `#d8d2c4` hairline, `#c3baa8` strong rule.
- **Oxide:** `#b23a2b` primary action and live accent, `#8d2b1f` hover,
  `#f3e2dc` selection.
- **Signals:** `#2f6b4f` healthy, `#a8322a` error, `#8a5a17` paused.

Flat surfaces, 1px rules, 2–6px corners. No glass, no blur, no 999px pills, no
icon-card grids. Shadows are reserved for sheets that float above the page (the
studio sheet, the analytics key gate).

## Type

- **IBM Plex Sans** for controls, body, tables, and navigation.
- **Source Serif 4** for display headings and the script sheet.
- **DM Mono** for timecodes, counters, table numbers, labels, and measurements.
- Functional text is at least 11px; body and notes are 12px or larger.

## Surfaces

### Studio (`/studio`)

A 56px topbar, a voice rail, a serif script sheet, and a take rail. Oxide is the
only solid primary control. The waveform is the only motion.

### MCP setup (`/mcp`)

The human setup page uses the same paper world, with tabs for Claude, Claude
Code, and Cursor plus a copy-paste agent prompt.

### Operator analytics (`/stats.html`)

An operator readout, not a marketing dashboard:

- A 56px topbar with the Koe mark, the `Operator` workspace label, and a live
  connection status.
- A single four-cell readout rule for voiceovers, words today, product users,
  and active/queued slots. No metric cards.
- A traffic ledger and a capacity aside.
- Voiceover users ranked by words, and request sources ranked by HTTP requests.
- A daily ledger and a quiet footer explaining the measurement.
- The key gate is a sheet, not a modal dialog. It stores the admin key in
  local storage and strips a `?key=` parameter from the address bar after use.

## Measurement language

- **Visitors** are all unique subjects seen in a window, including crawlers and
  page loads. Static assets still count as HTTP hits but do not create visitors.
- **Product users** are unique subjects with a real action in the window:
  voiceover, MCP call, preview, download, or key registration. Bots cannot
  become product users by crawling pages.
- **All HTTP hits** is intentionally the broadest number and is labelled as
  such. It is not the user count.
- Anonymous visitor ids are keyed HMACs from `guard.anonSubject()`. Raw IPs are
  never stored. Legacy raw-IP records are migrated on load.
- Requests and words attach to the same subject id, so a visitor's word count
  cannot drift to a different record.

## Motion and interaction

- Auto-refresh is 15 seconds, with pause and manual refresh controls.
- No animation is required to understand the page. Transitions are limited to
  hover and focus states and respect `prefers-reduced-motion`.
- Every table has a caption, numeric columns use tabular figures, and the key
  gate has a visible label and an alert region for errors.
