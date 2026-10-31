# VRM Desktop Mate — 開発メモ

Electron + three.js + @pixiv/three-vrm 製のデスクトップマスコット。
MediaPipe Face Landmarker で顔・視線を推定し、キャラクターがユーザーの方を向く。

## コマンド

```bash
npm start          # 通常起動(bundle 生成後に electron 起動)
npm run dev        # DevTools付き・クリック透過なし・状態ログ出力
npm run check      # 構文チェック + esbuild バンドル検証(エディタ上の確認用)
npm run dist:dir   # 署名なし .app を dist/ に出力(動作確認用)
npm run dist       # dmg / zip ビルド
```

## 環境注意(重要)

- Devin Desktop / Windsurf 系のターミナルでは `ELECTRON_RUN_AS_NODE=1` が
  環境変数に混入していることがある。この状態で `npm start` すると
  `TypeError: Cannot read properties of undefined (reading 'whenReady')`
  で即落ちる。起動時は以下を使うこと:

  ```bash
  env -u ELECTRON_RUN_AS_NODE npm run dev
  ```

- プロジェクトを別パスへ移動した場合、カメラ権限は Electron.app のパス単位で
  再要求される(macOS の TCC 仕様)。

## 構成

- `src/main.js` … メインプロセス。透明・最前面・クリック透過ウィンドウ、Tray メニュー、設定永続化(`~/Library/Application Support/VRM Desktop Mate/settings.json`)
- `src/renderer/tracker.js` … Face Landmarker → 顔の向き/距離/視線の推定
- `src/renderer/character.js` … VRM 読み込みと行動ステートマシン(idle/walk/watched/held/fall/land/kiss/spin/pet/pose/clock)
- `src/renderer/app.js` … 画面座標↔シーン座標の対応、注視判定、マウス操作
- `src/renderer/motions.js` … Mixamo FBX ポーズの VRM リターゲット
- `src/motions.json` … ポーズ一覧(`source: "vrma"` は同梱 .vrma、それ以外は AnimeVRM Motions から初回 DL キャッシュ)
- `tools/vrma/` … .vrma モーション生成ツール
- `vrm/` … ユーザー所有の VRM アバター集(8体)
- `assets/models/default.vrm` … 同梱デフォルトモデル(VRM1_Constraint_Twist_Sample)

## カメラなし検証

```bash
MATE_FAKE_CAMERA=/path/to/face.y4m env -u ELECTRON_RUN_AS_NODE npm run dev
```
