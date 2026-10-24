# textbundle-files

## 1.0.3

### Patch Changes

- No visible change. The retry for a pack that a sync still writes now uses the error kind, not the error message text.

## 1.0.2

### Patch Changes

- Auto import no longer waits 2 seconds or scans again when it refuses a pack. A read error still gets one retry. A refused pack that a sync is still writing gets one more try when its size changes. The error notice shows only if that try fails, or after 60 seconds with no change.

## 1.0.1

### Patch Changes

- Auto import now handles one pack at a time. A sync that adds many large packs keeps only one pack in memory.
