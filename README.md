# VRM Desktop Mate

デスクトップ上をVRMキャラクターが歩き回り、カメラで捉えたあなたの顔の位置・向き・視線に合わせて、首や目線をあなたの方へ向けるデスクトップマスコットです。Mac / Windows / Linux に対応。

- Electron + three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
- 顔・視線推定: [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)（モデル・WASMは同梱。映像は端末内でのみ処理し、保存・送信はしません）

## できること

- 画面下端（Dockの上）を歩く / 立ち止まる / 振り返る（プロシージャルな歩行アニメーション）
- カメラで顔の3D位置・向き・視線（目の動き）を推定し、キャラクターの体・首・頭・目をあなたの方へ向ける
- あなたが首を傾けると、キャラクターも鏡のように首を傾ける
- あなたがキャラクターを見つめると、立ち止まってこちらを向いて笑う
- 見る先を「あなたの顔」/「あなたが見ている場所」で切り替え
- キャラクターをドラッグでつまんで移動、離すと落下して着地。クリックで驚く
- カメラがオフ・顔が見つからない時はマウスカーソルを目で追う
- 好きなVRM（VRM 0.x / 1.0）をメニューから選択、またはキャラクターにドロップして差し替え

ウィンドウは画面全体を覆う透明・最前面・クリック透過ウィンドウで、キャラクターの上にカーソルがある時だけマウス操作を受け付けます。

## ビルド済みアプリを使う

[Releases](https://github.com/8tn2pr9wwm/vrm-desktop-mate/releases) から各OS向けをダウンロード。

### Mac

`.app` を `/Applications` などに置いてダブルクリック。Dockに出ないメニューバー常駐型アプリです（右上の人型アイコンがメニュー）。未署名なので初回は右クリック →「開く」。初回起動時にカメラ許可を求められます。

### Windows

`Setup *.exe`（インストーラー、x64/32bit両対応）または `*-win.zip`（ポータブル）。未署名のため初回に SmartScreen が出ます →「詳細情報」→「実行」。

- **メニューの出し方**: キャラクターを**右クリック**するか、タスクバー右端のトレイアイコン（「^」の中に隠れていることが多い）をクリック
- トレイアイコンを常時表示するには: 設定 → 個人用設定 → タスクバー → 他のシステムトレイアイコン → VRM Desktop Mate を ON
- 終了はメニューの「終了」から（Dock/タスクバーに出ない仕様のため）

### Linux（PC / Raspberry Pi / Radxa 等の SBC）

`*.AppImage` が手軽です（実行権限を付けてダブルクリック）。

- AppImage が起動しない場合: `sudo apt install libfuse2`、または `--appimage-extract-and-run` を付けて実行
- **X11 セッション推奨**: 透明・最前面・クリック透過ウィンドウは X11 でのみ正常動作します。Wayland では制約が多いです（Ubuntu: ログイン画面の歯車 → 「Ubuntu on Xorg」、Raspberry Pi OS: `raspi-config` → Advanced → Wayland → X11）
- アーキテクチャ: `x64`(PC) / `arm64`(Raspberry Pi OS 64bit, Radxa OS 等) / `armv7l`(32bit Raspberry Pi OS)
- トレイが出ない環境（GNOME では AppIndicator 拡張が必要なことがある）でも、キャラクターの右クリックで同じメニューが出ます

### SBC（Radxa Cubie A7Z 等）向けメモ

- カメラは **USB Webカメラ** を使用（MIPI CSI カメラは Chromium から直接は見えません。USB-C ボードではハブ経由で）
- 非力なCPUでは顔推定のfpsが落ちます。キャラクターサイズを小さめにすると軽くなります

#### Radxa / Allwinner (PowerVR GPU) での起動

`error while loading shared libraries: libz.so` が出る場合は開発用パッケージが必要:

```bash
sudo apt install zlib1g-dev   # libz.so を提供（zlib1g には libz.so.1 のみ）
```

PowerVR のドライバは Chromium の要求する GLX/EGL を提供しないため、**ハードウェアGPUは使えません**。以下のフラグでソフトウェア WebGL (SwiftShader) で動作します:

```bash
./VRM.Desktop.Mate-*-arm64.AppImage \
  --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

- `--no-sandbox`: カーネルのサンドボックス機構が無い環境で必要
- `--use-angle=swiftshader` + `--enable-unsafe-swiftshader`: 新しい Chromium でソフトウェア WebGL を有効化（`--disable-gpu` は WebGL 自体を無効化するので**使わない**）

起動スクリプト例:

```bash
cat > ~/vrm-mate.sh <<'EOF'
#!/bin/bash
exec ~/Downloads/VRM.Desktop.Mate-*-arm64.AppImage \
  --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@"
EOF
chmod +x ~/vrm-mate.sh
```

## 動かし方（開発）

```bash
npm install
npm start          # 通常起動
npm run dev        # DevTools付き・クリック透過なし・状態ログ出力
```

メニューバーの人型アイコンから各種設定ができます。初回起動時にカメラへのアクセス許可を求められます。

## Macアプリとしてビルド

Mac上で:

```bash
npm install
npm run dist       # dist/ に dmg と zip (arm64 / x64) を出力
```

署名していないビルドは、初回起動時に Finder で右クリック →「開く」で起動してください。

## メニュー

| 項目 | 内容 |
| --- | --- |
| カメラで顔・視線を追従 | カメラのオン/オフ |
| 見る先 | あなたの顔 / あなたが見ている場所 |
| 首の傾きをまねる | 頭のロール（傾き）をミラーする |
| 目に目線を入れる(プライバシー) | 目に黒い帯をかぶせて顔を隠す |
| 歩き回る | オフにするとその場で待機 |
| 大きさ | 小 / 中 / 大 / 特大 |
| 視線キャリブレーション | キャラクターを見つめながらクリックすると、推定視線のズレを補正 |
| カメラプレビューを表示 | 推定値・顔ランドマーク・推定視線位置（ピンクの丸）を表示 |
| 投げキッス / くるっと回る / しゃがんで猫を撫でる | その動作をすぐ実行 |
| ポーズ（AnimeVRM Motions） | カテゴリ別のポーズ、または「おまかせ」でランダム |
| VRMを開く… | 任意のVRMファイルを読み込む |

設定は `settings.json` に保存されます（Mac: `~/Library/Application Support/VRM Desktop Mate/`、Windows: `%APPDATA%/VRM Desktop Mate/`、Linux: `~/.config/VRM Desktop Mate/`）。メニューにない調整値:

- `pixelPitchMm`（既定 0.2）: 画面の1ポイントあたりの物理サイズ(mm)。MacBook内蔵画面はおおむね0.2。外部モニタでは `画面の横幅(mm) / 横の解像度(ポイント)` を設定
- `cameraFovDeg`（既定 65）: カメラの水平画角
- `characterHeight`: キャラクターの身長(px)

## 仕組み

- `src/renderer/tracker.js`: Face Landmarker の顔変換行列から顔の向き（yaw/pitch/roll）、虹彩間距離から距離、ランドマーク位置から頭の3D位置、ブレンドシェイプ（eyeLook*）から目の向きを推定し、「Webカメラ=画面上端中央」を原点とする画面座標系(m)へ変換。視線レイと画面平面の交点を注視点とする
- `src/renderer/app.js`: 画面座標(px)とシーン座標(m)の対応付け、注視判定、マウス操作
- `src/renderer/character.js`: VRMの読み込み、行動ステートマシン（idle / walk / watched / held / fall / land / kiss / spin / pet / pose）、歩行・待機ポーズ、首と目の向き、表情
- `src/renderer/motions.js`: Mixamo形式FBXのポーズをVRMの正規化ボーンへリターゲット。`src/motions.json` が使うポーズの一覧

## カメラなしでの動作確認

```bash
MATE_FAKE_CAMERA=/path/to/face.y4m npm run dev
```

Chromiumの擬似カメラ機能で、y4m/mjpeg動画をカメラ入力として使えます。

## ライセンス

- コード: MIT
- 同梱モデル `assets/models/default.vrm`: pixiv Inc. の VRM1_Constraint_Twist_Sample（[VRM Public License 1.0](https://vrm.dev/licenses/1.0/)、再配布可）
- `assets/mediapipe/face_landmarker.task`: Google MediaPipe（Apache-2.0）
- ポーズモーション: [AnimeVRM Motions](https://uemegu.github.io/AnimeVRM.Motions/)（uemegu）。FBXはこのリポジトリに含めず、初めて使う時に配布ページからダウンロードし `~/Library/Application Support/VRM Desktop Mate/motions/` にキャッシュします。配布元に明示的なライセンス表記が見当たらないため、アプリとして配布する場合は配布元の利用条件を確認してください
