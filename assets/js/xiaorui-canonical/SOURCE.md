# XiaoRui canonical browser runtime

These files are vendored without source changes from:

- Repository: `C:\Users\mamam\Desktop\xiaorui_realtime_rebuild`
- Branch: `main`
- Commit: `32ffb2feae3b5d3fceeb1fb0e722555350388f00`

The RichMe-specific DOM rendering and Preview/production endpoint selection stay in
`assets/js/xiaorui-realtime.js`. Do not move WebSocket, session ownership, ASR,
welcome, PCM scheduling, generation completion, input-gate, or reconnect logic
into that UI adapter.
