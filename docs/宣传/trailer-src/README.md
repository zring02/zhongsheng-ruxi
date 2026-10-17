# 宣传片源文件

- trailer.html：整支片子（Three.js 体素场景 + 字幕叠层），`window.renderAt(t)` 按秒画任意一帧。`?rs=0.75` 是 3D 部分的渲染缩放。
- cap.mjs：用 Playwright 逐帧截图。`node cap.mjs video 0 59.5 frames`；`node cap.mjs stills 1.2,30 0 st` 出几张静帧。
- music.py：用 numpy/scipy 合成配乐和音效，输出 music.wav（59.5 秒）。
- slice_*.jpg：画面线程动画小样的截图（插片用）。

依赖（和 trailer.html 放同一目录）：
- `npm pack three@0.160.0` 解压成 `package/`
- `npm pack @fontsource/noto-serif-sc@5.2.9` 解压成 `fserif/`，`npm pack @fontsource/noto-sans-sc@5.0.19` 解压成 `fsans/`
- 在该目录起静态服务：`npx http-server -p 8765 -s -c-1 .`

合成：
`ffmpeg -framerate 30 -i frames/f_%05d.jpg -i music.wav -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -af loudnorm=I=-14:TP=-1.5:LRA=11 -shortest out.mp4`

源文件已包含两处小修（气泡不出边框、结尾卷轴下的小字下移），成片 MP4 还没带上，下次重渲染时生效。

## B站横屏封面（2026-10-15）
- `cover.html` = trailer.html 改成 1920×1080，加了 `window.cover(v)`（v = 'lie' / 'five' / 'epic'）。
- 主封面：`node capone.mjs 'g={"shift":1.2,"dist":9.6,"yaw":18,"pitch":11}'` → c_g.png
- 4:3 版：`node capone.mjs 'q2={"shift":0.2,"dist":8.8,"yaw":18,"pitch":11,"x0":240,"ts":0.86,"thmax":1350,"nojie":true,"bcy":400}'`，再裁 x 240–1680。
- 备选：`node capcover.mjs five`
- 都要先在本目录起 `http-server -p 8765 -s -c-1 .`
