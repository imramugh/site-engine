# Motion runtime conventions

`mountMotionRuntime` progressively enhances elements marked with
`data-motion-effect`. The no-JavaScript state must be a readable still: start
effects paused in CSS and do not depend on the runtime for content visibility.

Use `data-motion-toggle` on the accessible footer control. The runtime stores a
visitor's explicit `reduce` or `allow` choice when storage is available; that
choice takes precedence over `prefers-reduced-motion`.

For video and long-running animation, place the video inside a motion-effect
element (or mark the video itself), provide a `poster`, and do not use
`autoplay`. The runtime only pauses media. It never starts playback, so native
controls and browser autoplay policy remain authoritative. Effects are paused
when reduced motion is selected, while off-screen, and within `form` or
`[data-urgent-contact]` contexts.

Theme renderers should call `resolveMotionPreset(intent, preset, supported)`.
An available selected preset wins. If it is unavailable after a theme change,
the declared intent is used only if the new theme supports it; otherwise the
renderer must leave a still frame.
