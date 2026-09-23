# システム不変条件 (System Invariants)

このドキュメントは、本システム（cividge-kv-worker および cividge）が正常に動作するために、**いかなるコード改修やリファクタリングを行っても絶対に崩してはならない性質（不変条件）** を定義したものです。

新規機能の追加や最適化を行う開発者（および AI エージェント）は、必ずこのルールを遵守してください。

---

## Lifecycle authority (supersedes earlier tombstone/local-reference text)

- A **Link** is only the canonical `host:filename` delivery name. An
  **ObjectRef** is only `r2:<s3Key>` or `ipfs:<cid>`. Neither substitutes for
  the other.
- The SQLite-backed `ObjectLifecycle` Durable Object named from the canonical
  ObjectRef is the only authority for the Object-to-Link relation and release
  state. Delivery KV is a read-optimized projection; browser localStorage is
  UI/cache only.
- Public delivery performs one canonical KV lookup and never calls the Durable
  Object, lists Links, repairs state, or probes storage on a KV miss.
- A Link mutation is authoritative only through `createLink` / `removeLink`.
  `requestRelease` may start whole-Object cleanup only when the authoritative
  Link set is empty.
- Placement release is distinct from Object release. It may be requested only
  when the Durable Object sees a surviving PRESENT placement. FIFO therefore
  cannot infer safety from browser state.
- R2 cleanup is performed by the Worker binding. Filebase/Kubo credentials may
  remain browser-held, but the browser may execute only a Durable-Object-issued
  placement task and must report success or retryable failure. Browser-held
  credentials remain an explicit trust boundary and can bypass Cividge itself;
  they are not lifecycle authority.
- `ACTIVE`, `RELEASE_PENDING`, `RELEASING`, `RELEASED` and the closed placement
  states are persisted before external I/O. A retryable failure never becomes a
  release success. A new Link can cancel `RELEASE_PENDING` only before any
  Placement starts release. Plain `createLink` cannot resurrect `RELEASING` or
  `RELEASED`; an explicit, successfully confirmed storage upload may re-acquire
  a `RELEASED` Placement through a new generation and then recreate the Link.
  `RELEASING` always remains non-linkable until its claim completes or expires.

---

## 0. アーキテクチャの根本原則と倫理憲章 (Core Architecture Principles)

### [INV-CORE-001] 無料枠の徹底節約とサイバー攻撃バッファの維持原則 (Zero-Waste & Attack Buffer Principle)
* **規則 (Rule)**:
  本システムは、**Cloudflare の無料アカウント枠（KV 書き込み/リスト: 1日1,000回、KV 読み込み: 1日100,000回）の範囲内で完全に自活・運用されること** を絶対の前提とする。
  通常運用におけるリソース消費を極限まで削ぎ落とし、**1日の大半の消費枠を「サイバー攻撃（悪意あるランダム URL DoS やクローリング）に対する防衛バッファ」として温存・維持しなければならない (MUST)**。

* **設計倫理 (Rationale & Philosophy)**:
  Web 上で公開されている以上、存在しないランダムなパスを1秒に1回叩き続けるような DoS 攻撃（1日約 86,400 回）は日常的に発生し得る。
  もしシステムが平時で無駄な消費をしていれば、攻撃を受けた瞬間に無料枠が尽き、正規の配信や台帳アクセスが停止してしまう。
  「1秒に1回・1日8万回以上の攻撃が飛んできても、残りの1万数千回で平然と正規のサービスを維持できる」だけの圧倒的な節約アルゴリズム（無駄打ちゼロの単一キー探索、エッジキャッシュによる即時防衛、不要な書き込み・走査の徹底排除）を追求すること。**「動けばよい」「無料枠の内側だから多少無駄遣いしてもよい」という甘えは設計の敗北である。**

---

### [INV-CORE-002] 完全 BYOC と開発者非特権・秘密情報非ハードコード原則 (Pure BYOC & Zero-Privilege Principle)
* **規則 (Rule)**:
  フロントエンド（`cividge.pages.dev`）は全ユーザー共通の単なる静的エントリポイントであり、バックエンド（Cloudflare Worker、KV、ストレージノード等）は**各ユーザーが自身の Cloudflare アカウントで自己調達・自己管理するもの（Bring Your Own Cloud: BYOC）** である。
  **開発者自身も何ら特権を持たない「ただの1ユーザー」に過ぎない。**
  したがって、ソースコードやリポジトリ設定に、開発者や特定個人の API トークン、アカウント ID、シークレット、個人所有ドメイン名、特定環境専用の固定値を**絶対にハードコードしてはならない (MUST NOT)**。

* **設計倫理 (Rationale & Philosophy)**:
  すべての接続設定・認証情報は、クライアント側のローカル環境（`localStorage` 等）またはユーザー自身の Worker 環境変数（Secrets）から動的に供給されなければならない。
  コード上に特定ユーザーの個人ドメインや秘密鍵をハードコードすることは、他ユーザーのポータビリティを奪い、情報漏洩事故を招く極めて危険なアンチパターンである。開発者は常に「自身の環境もただの1インスタンスに過ぎない」という意識でコードを書かなければならない。

---

### [INV-CORE-003] 過剰な自動保護の禁止と根本原因の究明原則 (Anti-Overprotection & Root Cause Principle)
* **規則 (Rule)**:
  「台帳にないのに実体がある」「手動で直接バケットに置かれた」といった、通常運用ではあり得ない異常な状態遷移を想定して安易に自動フォールバック（自己修復）を組み、それによって Cloudflare の無料枠（KV や R2 のリクエスト回数）を平時や攻撃時に浪費することを厳格に禁止する (MUST NOT)。

* **設計倫理 (Rationale & Philosophy)**:
  1. **過剰な自動保護（おせっかいコード・YAGNI違反）の排除**: ユーザーから明確に要求されていない架空のユースケース（ダッシュボードからの手動操作の救済など）を勝手に想定してコードを肥大化・複雑化させてはならない。
  2. **対症療法ではなく原因療法の徹底**: 異常な状態遷移（同期ズレや孤児ファイル）が観測された場合、自動フォールバックで誤魔化して取り繕うのではなく、まず「なぜそのような異常な状態遷移が起きたのか（削除漏れや期限切れ処理のバグ等）」という根本原因を疑い、根治しなければならない。
  3. **防御壁の維持**: 存在しないファイルや異常なリクエストに対しては、裏側のストレージを探しに行くような過保護な救済を一切行わず、エッジで即座に「404 Not Found」として門前払いしなければならない。

---

### [INV-CORE-004] 読み取り・描画時の書き込み（副作用）密輸および過剰自己修復の全面禁止 (Read-Safe & Anti-Side-Effect Principle)
* **規則 (Rule)**:
  閲覧、一覧取得、描画、配信アクセス等の「読み取り系操作（GET / HEAD / RENDER）」において、暗黙的・自動的に KV の書き込み（`put` / `delete`）や外部通信の連打（副作用）を発火させることを厳格に禁止する (MUST NOT)。
  あらゆる読み取り処理は完全な Read-Only でなければならず、書き込み枠（1日1,000回）を1回たりとも消費してはならない。

* **禁止される実装パターン（アンチパターン規律）**:
  1. **副作用の密輸（Side-effect Smuggling）**:
     - 画面を開いた時、一覧を描画した時、カードを表示した時、または配信 URL を踏んだ時に、裏側で勝手に `registerKvCid` や `kv.put` / `kv.delete` を実行してはならない。
  2. **漂流ファイル安否確認 (`auditDriftingFiles`)**:
     - HEAD は availability observation に限定する。成功は失敗回数をリセットし、3回連続失敗は local UI cache からの RETIRED 表示にだけ使用してよい。
     - observation から Link 削除、KV mutation、Object release、Placement cleanup を発火してはならない。
  3. **画面起動時バルク実行（Auto-Bulk On Mount）**:
     - アプリ起動やページ描画と同時に、全件走査して外部通信や KV 書き込みを連打してはならない。
     - 整合性の再同期や全件ステータス更新は、ユーザーが明示的に「同期ボタン」を押した時のみ（明示的オプトイン）実行を許可する。
  4. **妄想的フォールバックと空振り照会（Paranoid Fallback）**:
     - メタデータやリクエスト情報から「存在しない」ことが自明なキー（別バックエンドの `blob_` キー、非該当ホスト、廃止された旧インデックスキー等）を、「あるかもしれない」と憶測で KV に問い合わせてはならない。
  5. **ゾンビ自己修復（Zombie Self-Healing）**:
     - 台帳に存在しないキーや不整合を発見した際、裏で勝手に台帳へ再登録・自動修復してはならない（期限切れファイルのゾンビ復活・書き込み枠破壊の防止）。
     - 未知のキーはエッジキャッシュ付き 404 で即座に門前払いし、不整合は根本原因（作成・削除フロー）の改修で根治しなければならない。
  6. **キャッシュ無視と通信先行（Cache-Bypass Syndrome）**:
     - クライアントキャッシュ（localStorage / メモリ）やエッジキャッシュ（Cache API）を意図的にすり抜ける（`cache: "no-store"` の濫用など）実装を禁止する。
     - クールダウン判定やガードは通信の「前」に配置し、不要な通信を1回たりとも飛ばしてはならない。

---

### [INV-CORE-005] Local-First UI と server-authoritative lifecycle の分離
* **規則 (Rule)**:
  1. **手元キャッシュの差分更新 (Optimistic UI Cache)**:
     ファイルの追加・削除・リネーム・メタデータ変更等の通常操作完了後、サーバー（KV/R2）への全件再照会・再フェッチ（`fetchKvFiles` / `fetchAndRenderR2Files`）を行ってはならない (MUST NOT)。手元のキャッシュ（`localStorage` およびメモリ内データ構造）を差分更新し、即座に画面を再描画しなければならない。
     ただし localStorage は UI / recoverable cache であり、Link 関係、最終参照、Object release の authority ではない。
  2. **起動時・画面遷移時のサーバー通信ゼロ化 (Zero-Fetch on Mount / Transition)**:
     手元にローカル台帳（`localStorage`）が存在する場合、画面初期ロード時やタブ切り替え時にサーバーへ全件フェッチを飛ばしてはならない (MUST NOT)。手元台帳からミリ秒単位で即座に描画し、サーバー同期はユーザーが明示的に「🔄 更新」ボタンを押した時のみ（明示的オプトイン）に限定する。
  3. **表示上の解決と lifecycle authorization の分離**:
     並び替え、表示フィルター、同名警告等は手元キャッシュで解決してよい。一方、Link 作成・削除、最後の参照判定、Placement release は canonical ObjectRef から一意に決まる Durable Object を必ず通す。クライアントが `isCidShared`、墓標、手元件数等から物理削除を許可してはならない。公開 GET と通常 UI 操作のいずれにも KV 全件走査フォールバックを持たせてはならない。
  4. **墓標・クライアント最終参照判定の禁止**:
     旧 tombstone queue と `make_tombstone` は使用しない。Kubo unpin を含む Placement cleanup は Durable Object の generation-bound claim を取得した executor だけが実行し、結果を report する。

* **設計倫理 (Rationale & Philosophy)**:
  - ブラウザの `localStorage` は安価かつ大容量（通常5MB〜10MB。タプル圧縮台帳なら数万件格納可能）であり、高速に永続化できる。
  - 一方で Cloudflare KV の `list()` 枠は **1日たった 1,000回** しかなく、全リソースの中で最も貴重である。
  - 操作のたびに「念のため最新をサーバーから取り直す」という旧来の Web アプリ設計は、1回削除するごとに `list()` 枠を消費し、一瞬で無料枠を破綻させる。
  - 「手元にあるデータは手元で解決し、手元の台帳を更新する」「他デバイスとの同期が必要な時だけ明示的にフェッチする」という Local-First 原則を徹底することで、通常運用における KV `list()` の消費を「完全 0 回」に抑え込むことができる。

---

## 1. 配信と台帳の整合性 (Delivery & Ledger Consistency)

### [INV-DELIVERY-001] 台帳存在時の 404 キャッシュ禁止
* **規則 (Rule)**:
  KV 台帳に対象キーのレコードが存在する場合、いかなる理由（上流ストレージの応答遅延、一時的タイムアウト、自前ノードの電源オフ等）があっても、**404 Not Found をエッジにキャッシュ（`s-maxage > 0`）させてはならない (MUST NOT)**。

* **理由 (Rationale)**:
  台帳にレコードが存在することは「システム上にそのファイルが存在する」という単一の真実源（Single Source of Truth: SSOT）である。
  上流ストレージが一時的にデータを返せなかったからといって「存在しない（404）」という嘘をエッジにキャッシュ（固定化）させると、アップロード直後やノード再起動時に、正規のファイルが数分間アクセス不能になる致命的な障害が発生する。

* **満たすべき性質 (Required Behavior)**:
  1. 台帳に存在するキーで上流取得が遅延している場合、レスポンスは以下のいずれかでなければならない：
     - **`Cache-Control: no-store`**（キャッシュ禁止。次回アクセスで即時再試行可能にする）
     - または **5xx（503 Service Unavailable / 504 Gateway Timeout 等）** として最小限の時間（十数秒以内）のみマイクロキャッシュする。
  2. 登録直後（Grace Period）は、上流のピン留め遅延を吸収するため自動リトライを行い、それでも取得できない場合は即座に `no-store` で返却すること。

* **禁止事項 (Prohibited)**:
  - 台帳に存在するキーに対して、上流エラー時に `404 Not Found` かつ `s-maxage=60` 等の長期キャッシュヘッダを付与して返却すること。

---

### [INV-DELIVERY-002] 静的リレーホスト制限の環境変数同期
* **規則 (Rule)**:
  静的リレー（Cloudflare Pages 等）を経由して配信レイヤへアクセスする構成において、正規のリレーホストからのアクセスを不当に 404 遮断してはならない。

* **満たすべき性質 (Required Behavior)**:
  - リレー元のホスト名は `STATIC_RELAY_PUBLIC_HOSTS` 環境変数（Worker Secret）で一元管理し、正規リレー経由の正当なアクセスは `allowedHost` 制限を適切にバイパスさせること。

---

### [INV-DELIVERY-003] ストレージ状態に応じたゲートウェイ動的優先ルーティング ＆ 地域分散オープンゲートウェイ選定
* **規則 (Rule)**:
  上流 IPFS ゲートウェイへの問い合わせ順序は、KV 台帳のピン状態（`kuboStatus`、`unpinned` フラグ）に応じて動的に制御し、Filebase のダウンロード帯域（Egress）を保護しなければならない (MUST)。また、特定の私設回線（トンネル）に依存せず、公平でオープンな IPFS 分散ネットワークを通じてブロックを取得するため、429 で遮断する死滅したゲートウェイを排除し、地域分散された現役オープンゲートウェイ群を多重フォールバックとして維持しなければならない (MUST)。

* **満たすべき性質 (Required Behavior)**:
  1. **地域分散・高可用性パブリックゲートウェイ群の選定 (Gateways Pool)**:
     - **アジア太平洋（APAC）**: `https://apac.orbitor.dev/ipfs`（日本・アジア近隣最速。自宅ノードとの物理距離が近く、ミリ秒単位で DHT ブロックを吸い上げ可能）
     - **グローバル / 高速オープン**: `https://dget.top/ipfs`（高可用性オープンノード）
     - **北米（North America）**: `https://ipfs.orbitor.dev/ipfs`（Orbitor メインクラスタ）
     - **欧州（Europe）**: `https://eu.orbitor.dev/ipfs`（欧州分散ノード）
     - **中南米（LATAM）**: `https://latam.orbitor.dev/ipfs`（中南米分散ノード）
     - ※`ipfs.io`, `dweb.link`, `gateway.pinata.cloud` 等の無料非認証アクセスを 429（Too Many Requests）で遮断するゲートウェイは候補から除外すること。
  2. **Kubo Pin 済み (`kuboStatus: "pinned"`)**: DHT 経由で自宅 Kubo からブロックを取り寄せる上記現役公共ゲートウェイ群を最優先にし、Filebase ゲートウェイは自宅オフライン時の最終フォールバックに配置すること（Filebase 帯域消費をゼロ化）。
  3. **Filebase Pin 留め中 または アンピン漂流中 (`unpinned: true`)**: 最もデータ実体およびエッジキャッシュが最後まで残存している Filebase ゲートウェイ（`ipfs.filebase.io`）を最優先で問い合わせ、ダメなら公共ゲートウェイへフォールバックすること。※漂流中ファイルはエッジに 7日間キャッシュされるため Filebase 帯域への影響も極小。
  4. 自宅 Kubo の専用ゲートウェイ（`KUBO_GATEWAY_URL`）が設定されている場合は、最優先で問い合わせること。

---

### [INV-KUBO-001] 自宅 Kubo ノードの対外疎通と自律分散配信の必須要件
* **規則 (Rule)**:
  自宅 Kubo を Cividge の自律分散ストレージとして機能させるためには、単にローカルでデーモンを起動するだけでは不十分であり、世界中の IPFS ピアから自律的にブロックを発見・取得できる通信要件を満たさなければならない (MUST)。

* **理由 (Rationale)**:
  特定の私設直通回線（Cloudflare Tunnel 等）で特定ノードを贔屓する構成は、IPFS 本来のコンテンツ指向自律分散（Content Addressing）に反する。自宅ノードがあくまで「IPFS ネットワークに参加する対等な一ピア」として振る舞い、世界中のオープンゲートウェイから DHT 経由でブロックを引き抜いてもらうためには、外界からの着信受付と DHT への所持告知が必須となる。

* **満たすべき性質 (Required Behavior)**:
  1. **対外到達性（Inbound Dial-in / NAT越え）の確保**:
     - ルーターのポート開放を強いることなく、UPnP（`Swarm.DisableNatPortMap: false`）、AutoNAT、または AutoRelay / Hole Punching（`Protocols: /libp2p/dcutr`）により、外部の IPFS ピアが自宅 PC へ P2P 接続（TCP/UDP/QUIC）できるポートを確保・アナウンスすること。
  2. **DHT サーバー参加モードの必須 (`Routing.Type: auto` または `dht`)**:
     - `dhtclient`（クライアント専用）モードは、他ノードからブロックを探すことしかできず、自分が持つブロックの Provider Record（所持情報）を世界地図にアナウンスしないため、自律配信目的では絶対に使用してはならない (MUST NOT)。必ず `auto` 以上に設定し、Pin 留めしたブロックを世界中の DHT へ自律告知すること。
  3. **楽観的 Provide の有効化 (`Experimental.OptimisticProvide: true`)**:
     - Pin 留めしたブロックの DHT アナウンス遅延を最小化し、世界中のゲートウェイから即座に発見可能とすること。

---

### [INV-DELIVERY-004] R2 と IPFS の相互排他ルーティングと台帳防護
* **規則 (Rule)**:
  R2 および IPFS 配信の統合レイヤにおいて、台帳に存在しないキーはエッジで即座に 404 遮断し、かつストレージ探索は台帳種別（R2 / IPFS）に基づいて相互排他（無駄打ちゼロ）で実行しなければならない (MUST)。

* **満たすべき性質 (Required Behavior)**:
  1. 台帳に登録されていない未知のファイル名に対するアクセスは、R2 バケットや IPFS ゲートウェイを検索せず、即座に 404 Not Found を返却すること（ランダムパス DoS 攻撃の防護）。
  2. 台帳レコードが R2（`targetCid === "r2"` 等）の場合、まず R2 バケットを検索し、実体が存在すれば IPFS 上流フェッチは実行せず即時配信すること。
  3. R2 レコードで R2 バケットに実体が存在せず、台帳に `contentCid` が記録されている場合（Kubo 移行後）、**Filebase ゲートウェイ（`ipfs.filebase.io`）を 100% 完全に除外**し、公共 IPFS ゲートウェイおよび自宅 Kubo ゲートウェイのみを探索すること（無駄打ち・帯域浪費・404待機遅延の完全防止）。
  4. 台帳レコードが IPFS の場合、R2 バケットへの無駄な検索を行わず、IPFS ゲートウェイルーティングへ直行すること。

---

### [INV-DELIVERY-005] 単一ホスト照会と総当りKV探索の禁止（KV読み込み枠防護）
* **規則 (Rule)**:
  ファイル配信リクエストにおいて、KV 台帳を照会する際は **特定された単一ホスト（受信ホストまたは特定されたリレーホスト）のキーのみを照会しなければならない (MUST)**。複数のホスト候補をループ走査して KV の `get()` を連続実行する「総当り探索（Brute-force lookup）」は **厳格に禁止する (MUST NOT)**。

* **理由 (Rationale)**:
  存在しない URL（404）やランダム URL による DoS 攻撃を受けた際、ホスト候補をループ走査すると 1 リクエストで 5〜10 回もの KV `get()` が消費され、1日10万回の無料枠がわずか数時間で枯渇する。「山田太郎を探すのに鈴木太郎も佐藤太郎も全員呼び出す」ような非効率・危険な照会は設計の敗北である。

* **満たすべき性質 (Required Behavior)**:
  1. 静的リレー（Pages 等）からバックエンド Worker への中継は、クエリパラメータではなく **フォルダ構造（`/r/<relay-identifier>/<filename>`）** を最優先で使用すること。これにより、キャッシュバスター防御（`INV-INFRA-001`）によるクエリ除去（Ignore Query String）やブラウザの Referrer-Policy による情報欠落に一切影響されず、単一ホストを一発で確定できる。
  2. 照会は「特定されたホスト:ファイル名」の 1 回のみで完結させること（404 空振り時の KV 消費は最大 1 回）。
  3. 404 レスポンスは Cache API（`caches.default`）によりエッジでキャッシュ（最低 300 秒）し、同一パスへの反復攻撃に対する KV 消費を完全ゼロ（0 回）に抑え込むこと。

---

### [INV-FRONT-007] ドメイン独立性とエイリアス非干渉の原則（ドメイン連動汚染の完全禁止）
* **規則 (Rule)**:
  エイリアス（別ドメインURL）を追加する際、**元となったファイルのドメインが釣られて変わること、および他のファイルのドメインが連動して変わることは絶対にあってはならない (MUST NOT)**。また、画面上部の配信ドメインセレクタの切り替えや他ファイルの操作によって、既存カードの表示ドメインが巻き添えで変化してはならない。

* **理由 (Rationale)**:
  Cividge において各ファイルカードは、特定のドメインで公開されている独立した配信リソース（「ホスト名:ファイル名」を主キーとする実体）である。あるカードの操作や新ドメイン追加、あるいはグローバルセレクタの変更が既存カードのドメインを書き換えてしまうと、公開リンクの誤認、重複カードの発生、意図しないドメインでのURL共有事故を引き起こすため。

* **満たすべき性質 (Required Behavior)**:
  1. **カード単位のドメイン不可侵性**:
     - 各カードの配信ドメインは、awKey（ホスト名プレフィックス）および KV メタデータ（d / llowedHost）により決定論的に固定されなければならない。
     - 画面上部の配信ドメインプルダウン（getSelectedR2Domain()）は「これからアップロードする新規ファイルの宛先」の指定のみに使用し、既存カードの所属ドメインを上書きしてはならない。
  2. **エイリアス作成時の完全独立**:
     - エイリアス作成時、元のカードのレコードやローカルストレージ設定には一切触れず、新ドメインのレコードのみを独立して生成・台帳に追加すること。
     - 手元台帳更新（ddOrUpdateLocalLedgerItem）において、ファイル名単体（Key）による既存アイテムの一致判定を行ってはならず、必ずホスト名を含めた完全一意キー（awKey）で照合しなければならない。
  3. **ファイル名単体でのドメイン保存の禁止**:
     - ileDomainMap 等のブラウザストレージにおいて、ドメイン名を含まないファイル名単体をキーとしてドメインを記憶・上書きしてはならない。

* **禁止事項 (Prohibited)**:
  - エイリアス作成時に元カードの llowedHost やローカルドメイン設定を書き換えること。
  - 画面上部のドメイン選択変更イベントで、既存カードの配信URLを一括変更すること。

---

## 2. 台帳の完全性と実体保護 (Ledger Integrity & Pin Safety)

### [INV-LEDGER-001] Authoritative Link relation と参照残存時のrelease禁止
* **規則 (Rule)**:
  Durable Object の authoritative Link 集合または pending removal に1件でも参照がある限り、Object全体をreleaseしてはならない。クライアントの台帳走査や墓標でこの条件を代用してはならない。

* **理由 (Rationale)**:
  IPFS/分散ストレージにおいて、同一コンテンツ（同一 CID）は複数のファイル名やキーで共有される。1つのキーが削除されたからといって実体をアンピンしてしまうと、同一 CID を参照している他の正常なファイルまで破損・消失する。

* **満たすべき性質 (Required Behavior)**:
  - peer Link 作成は既存 Link を変更しない。
  - Link削除は authorityのbegin、KV projection削除、authorityのcompleteの順で実行し、途中失敗を同じidentityで再試行できる。

---

### [INV-LEDGER-002] Delivery KVをlifecycle authorityにしない
* **規則 (Rule)**:
  KVは配信projectionであり、共有判定・最終参照判定・物理削除authorizationのためにKV全件走査してはならない。これらはcanonical ObjectRefに対応する単一のDurable Objectが保持するLink関係で判定する。

* **禁止事項 (Prohibited)**:
  - KV list結果やlocalStorage件数からObject releaseを許可すること。
  - 公開GETでDurable Objectまたはstorageへフォールバックすること。

---

### [INV-LEDGER-003] 投稿メタデータの日時永続化
* **規則 (Rule)**:
  ファイル登録時（`upload.js`）、アップロード日時（`lastModified`、UNIX 秒 `t`）およびファイルサイズ（`s`）を必ず KV メタデータに永続保存しなければならない。

* **禁止事項 (Prohibited)**:
  - メタデータの日時フィールドを省略し、一覧取得側で動的に `Date.now()` を補完すること（一覧を表示・取得するたびに更新日時が現在時刻に化けてしまうため）。

---

## 3. インフラとエッジ防護 (Infrastructure & Edge Defense)

### [INV-INFRA-001] ゾーン設定におけるキャッシュバスター防御の義務
* **規則 (Rule)**:
  Cividge を公開配信するすべての Cloudflare ゾーン（カスタムドメインおよび静的リレー）において、メディア拡張子に対する Cache Rules では **必ず「すべてのクエリ文字列を無視 (Ignore query string)」を設定しなければならない (MUST)**。

* **理由 (Rationale)**:
  ランダムクエリ攻撃（`?rand=12345`）によるキャッシュバスター DoS 攻撃を防ぎ、Worker の無料枠枯渇および上流ストレージのパンクをエッジ（CDN）の最前線で 100% 防護するため。

* **運用手順**:
  詳細な設定手順については `cividge/docs/SECURITY_AND_CACHE_RUNBOOK.md` を参照すること。

---

### [INV-STORAGE-006] 実体未保持レコード（isFromS3 === false）の重複排除参照禁止
* **規則 (Rule)**:
  ファイルアップロード時の重複排除検査（`findR2ObjectByHash` / `findFilebaseObjectByCid`）において、手元台帳に同一 CID/ハッシュが存在する場合であっても、**当該レコードが物理ストレージに実体を持たない場合（`isFromS3 === false`、容量解放済み、Kubo単独保全、または漂流中）は、絶対に既存実体として参照してアップロードをスキップしてはならない (MUST NOT)**。
* **理由 (Rationale)**:
  Cividge はマルチストレージ・P2P 連携システムであり、R2 自動容量解放（FIFO）等により「台帳にレコードはあるが R2 実体は解放済み」という正当な状態が日常的に発生する。実体が存在しない空っぽのレコードを既存実体と誤認してアップロードをサボると、実体がどこにも存在しない 404 レコードが生成されてしまうため。
* **満たすべき性質 (Required Behavior)**:
  `item.isFromS3 === false` のレコードは重複チェック走査で無条件にスキップし、物理ストレージへの新規実体アップロードを確実に実行すること。


---

### [INV-CORE-006] ファイル・URL 対称性の原則（完全対等なハードリンクモデル）
* **規則 (Rule)**:
  すべての公開 URL（KV レコード）は、最初から `host:filename` という均一な一意キー構造を持たなければならず (MUST)、背後のストレージ実体（S3Key / CID）に対する完全に対等な参照ポインタ（ハードリンク）として扱わなければならない (MUST)。
  「コピー元（親・本物）」と「エイリアス（子）」のような主従関係や、ホスト名を持たない特権キー（単体キー）を設けてはならない (MUST NOT)。

* **状態遷移とライフサイクル (State Transition & Lifecycle)**:
  1. すべての Link は順序のないpeerであり、追加時に既存peerを変更・削除しない。
  2. active Linkまたはpending removalが存在する間、Object releaseは禁止する。
  3. 参照が0になったObjectはrelease candidateにだけなり、物理cleanupにはPlacementごとのcurrent claimが必要である。
  4. claimはIDとgenerationで閉じ、stale reportを拒否し、同じ完了reportはidempotentに受理する。

* **理由 (Rationale)**:
  キー名の形式（コロンの有無）で親子を区別する非対称なモデルは、元カードを先に消した際に残ったエイリアスが実体を消せなくなって孤児オブジェクト（容量浪費ゴミ）を生み出すか、または親削除時に他リンクを巻き添え破壊する致命的な欠陥を招く。Linux の inode/hardlink や IPFS の CID/名前と同様に、すべての URL を実体への対等なポインタとして扱うことが、最も堅牢で論理的な不変条件である。

---

### [INV-DELIVERY-006] ホスト・ドメイン完全独立と暗黙フォールバックの禁止
* **規則 (Rule)**:
  すべての配信ドメインおよび静的リレーは完全に対等であり、特定のホストを暗黙のデフォルトとして優遇したり、フォールバック採用してはならない (MUST NOT)。
  リクエストから配信ドメインが一意に特定できない場合、憶測で特定ホストのキーを探しに行かず、即座に「404 Not Found」として門前払いしなければならない。また、単体キーへのフォールバック照会も行わず、特定されたドメインのキー（`host:filename`）のみを 1 回で照会しなければならない。
