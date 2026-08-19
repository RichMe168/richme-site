# XiaoRui canonical browser runtime

These files are vendored without source changes from the validated XiaoRui release:

- Repository: `mamameya111-sketch/xiaorui-realtime`
- Validated tag: `xiaorui-realtime-2026-08-19-validated`
- Commit: `8bf9218a3f09d884d92e1ffc87417c80960ffa3e`

The RichMe-specific DOM rendering and Preview/production endpoint selection stay in
`assets/js/xiaorui-realtime.js`. Do not move WebSocket, session ownership, ASR,
welcome, PCM scheduling, generation completion, input-gate, or reconnect logic
into that UI adapter.
