# Goal

Clean up the prompt `@`-mention interaction so it feels intentional and low-friction for both file mentions and thread mentions.

The current interaction works functionally, but it feels noisy and visually inconsistent:

- file suggestions can look duplicated
- thread suggestions expose too much internal detail
- icons pull attention away from the primary label
- the empty-state / loading copy still implies file-only search in some cases

# Scope

In scope:

- Audit the current mention interaction from trigger through menu rendering
- Simplify the information hierarchy for file and thread suggestions
- Fix stale or misleading menu copy
- Reduce visual noise in suggestion rows
- Clarify thread-specific mention behavior in the UI

Out of scope:

- Changing the underlying mention token format
- Reworking promptbox keyboard navigation
- Changing the backend file/thread search sources
- Rich mention chips or inline render changes after insertion

# Implementation Steps

1. Audit the current mention data model and rendering split.

- Review how `usePromptFileMentions` builds file and thread suggestions.
- Review how `PromptMentionMenu` renders title, subtitle, and iconography.
- Review how placeholder and hint copy are derived in project-main and thread-follow-up contexts.

2. Fix file suggestion duplication.

- For file suggestions, avoid rendering the same path as both title and subtitle.
- Decide on one clear hierarchy:
  - likely primary label = basename or relative path
  - secondary label = parent directory only when helpful
- If a file has no useful secondary context, render a single-line suggestion.

3. Simplify thread suggestion rows.

- Reduce thread suggestions to the minimum context needed to disambiguate them.
- Do not always show full thread ids in the visible subtitle.
- Prefer concise thread metadata such as:
  - title
  - manager vs thread
  - maybe one small secondary hint only when needed
- Hide or defer internal-only details unless the user needs them to distinguish two similar threads.

4. Tone down mention-row iconography.

- Audit whether icons are needed for every suggestion row.
- If icons remain:
  - reduce contrast and visual weight
  - keep them secondary to text
- If the rows read better without icons, prefer removing them over decorating them.

5. Fix menu hint/loading/empty copy.

- The query hint should not incorrectly imply file-only search when thread mentions are supported in this context.
- Loading and empty states should reflect the actual search surface:
  - files only
  - files and threads
- Do not derive that copy from current result contents alone; derive it from the active mention mode/context.

6. Validate mention contexts separately.

- Project-main prompt:
  - files only
- Thread follow-up prompt:
  - files only or files + threads depending on current configuration
- Manager thread prompt:
  - ensure thread-mention UX feels especially clean, since this is the highest-value thread-mention surface

# Validation

- Manual QA:
  - trigger file mentions in the project-main prompt
  - trigger thread mentions in a manager thread
  - verify label/subtitle hierarchy feels clean
  - verify no duplicated file name/path presentation
  - verify thread suggestions do not show noisy internal details by default
  - verify loading/empty hint copy matches the actual search surface
- Focused tests:
  - mention-menu rendering tests for file and thread rows
  - hook tests if mention-context copy derivation changes

# Open Questions/Risks

- Should file suggestions show basename-first or full relative path as the primary label?
- Should thread suggestions ever expose ids in the menu, or only after selection/debugging?
- Are icons useful enough to keep, or is text-only the cleaner design here?
- Should manager-thread mention search bias threads ahead of files, or keep the current mixed ordering?
