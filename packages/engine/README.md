# Motion runtime conventions

`mountMotionRuntime` progressively enhances elements marked with
`data-motion-effect`. The no-JavaScript state must be a readable still: start
effects paused in CSS and do not depend on the runtime for content visibility.

Use `data-motion-toggle` on the accessible footer control. The runtime stores a
visitor's explicit `reduce` or `allow` choice when storage is available; that
choice takes precedence over `prefers-reduced-motion`.

Theme shells that need to share this controller with their own CSS can opt in
with `<html data-motion-controller="engine" data-motion-storage-key="…">`.
In that mode the engine is the sole owner of motion-toggle clicks and media
preference changes. It mirrors the effective value to both `data-motion` and
`data-motion-preference`, updates the button label and `aria-pressed`, and
always gives an operating-system reduced-motion request priority over a saved
`allow`. The optional storage-key attribute lets an existing theme retain its
visitor preference without a second controller.

For video and long-running animation, place the video inside a motion-effect
element (or mark the video itself), provide a `poster`, and do not use
`autoplay`. The runtime only pauses media. It never starts playback, so native
controls and browser autoplay policy remain authoritative. Effects are paused
when reduced motion is selected, while off-screen, and within `form` or
`[data-urgent-contact]` contexts.

Theme renderers should call
`resolveMotionPreset(intent, preset, supported, intentFallbacks)`. `none`
always renders a still frame. Otherwise, an available selected preset wins. If
it is unavailable after a theme change, the optional `intentFallbacks` map may
translate the declared intent to a supported preset (for example, `subtle` to
`fade`). Without a map, compatible intent and preset names work directly. A
missing or unsupported fallback leaves a still frame.

## Theme package validation

Before registering an already-extracted theme package, validate its directory without
loading its code:

```sh
site-engine-validate-theme /path/to/extracted-theme
```

The command emits JSON containing the validated install record and SHA-256 receipts
only when the package has a complete version-1 `contractSurface`. It rejects missing
or inconsistent contract declarations, unsafe paths, symlinks, oversized artifacts,
and missing entry or declared component files. The validator does not execute package
scripts or modules; the operator remains responsible for trusting the extracted source.
