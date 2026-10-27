# BangDB Manager

BangDB 와 주요 데이터베이스(PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, MongoDB, Redis)의 데이터베이스·테이블·데이터를 관리하는 **크로스플랫폼 관리 앱**입니다.
하나의 코드베이스로 다음 환경에서 동작합니다.

| 환경 | 방법 |
|------|------|
| 데스크톱 브라우저 (Windows/macOS/Linux) | 빌드된 웹앱을 열기 |
| 스마트폰 브라우저 → 홈 화면 설치 (PWA) | Android Chrome "홈 화면에 추가", iOS Safari "홈 화면에 추가" |
| Android / iOS 네이티브 앱 | Capacitor 로 래핑 (`npm run cap:android` / `npm run cap:ios`) |
| 서버 배포 | `Dockerfile` (정적 파일 + CORS 프록시 + DB 게이트웨이) |

| 서버 종류 | 연결 방법 | 기본 포트 |
|---|---|---|
| **BangDB (Go)** — [knoxxr/bangdb](https://github.com/knoxxr/bangdb) | `bangdb -http :18081 -password <pw> app.db` 로 JSON HTTP API 를 켬 (`http-api` 브랜치 이상). CORS 를 지원하므로 브라우저에서 프록시 없이 직접 연결됩니다. | 18081 |
| **BangDB 2.0 REST** — bangdb.com | 서버의 REST API 를 그대로 사용 | 18080 |
| **PostgreSQL · MySQL/MariaDB · SQL Server · SQLite** | DB 게이트웨이 경유 (아래 참고). 그리드 편집·구조 편집·SQL 콘솔은 BangDB (Go) 와 같은 화면 | 5432 · 3306 · 1433 · 파일 |
| **MongoDB** | DB 게이트웨이 경유. 컬렉션·문서(Extended JSON)·집계·인덱스 전용 화면 | 27017 |
| **Redis** | DB 게이트웨이 경유. 키 브라우저·타입별 편집기·명령 콘솔 | 6379 |

## 기능

- 서버 연결 여러 개 저장 (종류: BangDB (Go) / BangDB 2.0 REST, URL, 인증: 비밀번호(Basic) / API 키 헤더 / 로그인 토큰 / 없음)
- 연결 테스트
- 데이터베이스: 생성(`createDb`), DROP, 기존 DB 등록, 테이블 수 확인
- 테이블: 목록(검색), 생성 — Go: 컬럼 빌더(타입/PK/NOT NULL/UNIQUE/DEFAULT) 또는 SQL 직접 편집, REST: WIDE/NORMAL·키 옵션 — , 삭제
- 테이블 상세: 행 수, SQL 기반 데이터 조회(테이블/JSON 보기), 행 터치 → 수정/삭제(Go: 기본 키 기준 UPDATE/DELETE), JSON·CSV 내보내기, JSON/JSONL 대량 가져오기(진행률, 오류 시 중단), 행/문서 입력, 키 조회/삭제, 인덱스 추가/삭제(Go: CREATE/DROP INDEX, 기존 인덱스 목록), 테이블 정보(Go: 컬럼·PK·정의 SQL)
- 서버 상태 조회(`serverStats`)
- SQL 콘솔 (히스토리, Ctrl+Enter)
- REST 콘솔 (임의 메서드/경로/본문 + 최근 요청 기록)
- 모바일 하단 탭 / 데스크톱 사이드바, 다크·라이트 자동, 오프라인 캐시(PWA)

연결 정보는 기기의 브라우저 저장소(localStorage)에만 저장됩니다.

## 빠른 시작 (개발)

```bash
npm install
npm install --prefix proxy                         # DB 게이트웨이 드라이버 (pg, mysql2, mssql, mongodb, redis)
BANGDB_URL=http://192.168.0.10:18080 npm run dev   # http://localhost:5173
```

개발 서버는 `/gw/*` 에서 DB 게이트웨이도 함께 서비스하고, `/bangdb/*` 를 `BANGDB_URL` 로 전달합니다. 연결 추가 시 **"프록시 경유"** 를 켜면 CORS 없이 동작합니다.
같은 Wi-Fi 의 스마트폰에서는 `http://<PC IP>:5173` 으로 접속하면 됩니다.

BangDB 가 없을 때는 모의 서버로 UI를 확인할 수 있습니다.

```bash
node scripts/mock-bangdb.mjs          # 18080 포트에 모의 BangDB
```

## 배포 (웹/PWA)

```bash
npm run build                                   # dist/
npm install --prefix proxy --omit=dev
GATEWAY_TOKEN=secret BANGDB_URL=http://192.168.0.10:18080 npm run proxy   # http://0.0.0.0:8080 에서 dist + /bangdb 프록시 + /gw 게이트웨이
```

또는 Docker (SQLite 파일은 `/data` 볼륨):

```bash
docker build -t bangdb-manager .
docker run -p 8080:8080 -e GATEWAY_TOKEN=secret -e BANGDB_URL=http://192.168.0.10:18080 -v "$PWD/data:/data" bangdb-manager
```

`dist/` 는 순수 정적 파일이므로 아무 정적 호스팅에 올려도 되지만, 그 경우 BangDB 서버가 CORS 헤더를 보내지 않으면 브라우저에서 직접 호출이 막힙니다. 이때는 프록시를 함께 쓰거나 네이티브 앱을 사용하세요.
PWA 설치(홈 화면 추가)는 HTTPS 또는 localhost 에서만 가능합니다.

## Android / iOS 네이티브 앱

네이티브 셸에서는 `CapacitorHttp` 로 직접 호출하므로 CORS 제약이 없고 사내망의 `http://` 서버에도 연결됩니다.

```bash
npm run build
npm run cap:android     # android/ 생성 후 Android Studio 로 열기: npx cap open android
npm run cap:ios         # ios/ 생성 후 Xcode 로 열기 (macOS): npx cap open ios
```

이후 UI 를 수정했으면 `npm run build && npx cap sync` 로 반영합니다.
앱 ID는 `capacitor.config.ts` 의 `appId` 에서 바꿀 수 있습니다.

## BangDB (Go) 연결

knoxxr/bangdb 의 `httpapi` 패키지가 제공하는 엔드포인트를 사용합니다: `GET /v1/health`, `GET /v1/tables`, `GET /v1/tables/{name}`, `POST /v1/query`, `GET /v1/stats`. 모든 작업은 SQL 로 수행되며(`src/api/goapi.ts`), 행 수정·삭제는 모든 테이블에 있는 숨은 `rowid` 로 행을 찾습니다(기본 키가 없어도 편집 가능).

```bash
bangdb -http 0.0.0.0:18081 -password s3cret app.db     # 스마트폰에서 접속하려면 0.0.0.0 으로 바인딩
```

## 다른 데이터베이스 (DB 게이트웨이)

브라우저와 휴대폰은 PostgreSQL·MySQL 같은 DB 의 전용 프로토콜로 직접 접속할 수 없어서, DB 에 닿는 PC 에서 도는 **게이트웨이**(`proxy/gateway/`)를 거칩니다. `npm run dev` 와 `proxy/server.mjs`(Docker 포함)가 같은 주소의 `/gw/*` 로 게이트웨이를 서비스합니다.

- 연결 추가 → 서버 종류에서 DB 를 고르고 호스트·포트·계정(또는 연결 문자열)을 입력합니다. 게이트웨이 주소를 비우면 이 앱을 띄운 서버를 씁니다. **휴대폰 앱(Capacitor)은 게이트웨이 주소를 꼭 입력**해야 합니다.
- 모든 요청은 `POST /gw/<작업>` 에 `{ conn: {kind, host, port, user, password, database, …}, … }` 를 보내는 형태이고, 게이트웨이는 연결 설정별로 풀을 만들어 10분간 재사용합니다.
- 관계형 DB 는 BangDB (Go) HTTP API 와 같은 응답 형태(`tables`, `query`, `batch`)로 바꿔 주므로 그리드·구조 편집·덤프 화면을 그대로 씁니다. 방언 차이(따옴표, 페이지, 자동 증가, ALTER, EXPLAIN, 유지 보수 명령, 리터럴)는 `src/api/dialect.ts` 에 있습니다.
- 행 편집은 기본 키로 행을 찾습니다. 기본 키가 없으면 SQLite 는 `rowid`, PostgreSQL 은 `ctid` 를 쓰고, MySQL·SQL Server 는 읽기 전용이 됩니다.

| 환경 변수 | 뜻 |
|---|---|
| `GATEWAY_TOKEN` | 요청의 `x-gateway-token` 헤더가 이 값과 같아야 합니다 (연결 편집 → 게이트웨이 토큰). **설정하지 않으면 게이트웨이는 닫혀 있고**, 이 PC 에서 같은 주소로 연 앱(예: `http://localhost:5173`)의 요청만 받습니다. 휴대폰·다른 PC·Docker 에서 쓰려면 꼭 설정하세요. |
| `GATEWAY_ALLOWED_HOSTS` | 쉼표로 구분한 DB 호스트 목록. 설정하면 그 밖의 호스트로는 접속하지 않고, 연결 문자열(URI)은 받지 않습니다(호스트·포트 칸만) (예: `db1.local,10.0.0.5`). |
| `SQLITE_ROOT` | 게이트웨이가 여는 SQLite 파일의 폴더 (기본: 실행 폴더의 `data/`, Docker: `/data`). 이름이 `.db`·`.sqlite`·`.sqlite3`·`.db3` 인 파일만 열고, 심볼릭 링크를 풀어 그 밖을 가리키는 경로는 거부하고, `ATTACH`·`DETACH`·`VACUUM INTO` 도 막습니다. |
| `GATEWAY_MAX_BODY` | 요청 본문 최대 크기 (기본 32 MiB) |

TLS 는 기본으로 인증서를 검증합니다. 자체 서명 인증서는 연결 편집에서 "인증서 검증 안 함"을 켜야 합니다. 비밀번호를 포함한 연결 정보는 기기의 브라우저 저장소에만 저장되고, 게이트웨이는 요청마다 받아 메모리의 연결 풀에만 둡니다.

## BangDB 2.0 REST 엔드포인트와 검증 상태

`src/api/endpoints.ts` 에 모든 템플릿이 있습니다. BangDB 공식 문서로 확인된 항목은 `verified: true` 입니다.

| 키 | 메서드 | 경로 | 확인 |
|----|--------|------|------|
| listTables | GET | `/db/{db}/list` | ✔ |
| createTable | POST | `/db/{db}/table` | ✔ |
| rowCount | GET | `/db/{db}/{table}/count` | ✔ |
| addIndex | POST | `/db/{db}/{table}/index` | ✔ |
| putDoc | POST | `/db/{db}/{table}/doc` | ✔ |
| query | POST | `/db/{db}/query` (`{"sql": ...}`) | ✔ |
| dropTable | DELETE | `/db/{db}/{table}` | 추정 |
| getDoc / delDoc | GET / DELETE | `/db/{db}/{table}/doc/{key}` | 추정 |
| dropIndex | DELETE | `/db/{db}/{table}/index/{index}` | 추정 |
| tableInfo | GET | `/db/{db}/{table}/info` | 추정 |
| scanDocs | POST | `/db/{db}/{table}/scan` | 추정 |
| createDb / dropDb | PUT / DELETE | `/db/{db}` | 추정 |
| login | POST | `/login` | 추정 |
| serverStats | GET | `/stats` | 추정 |

"추정" 항목이 사용 중인 BangDB 버전과 다르면 **서버 연결 편집 → 고급: REST 엔드포인트 템플릿 재정의** 에서 연결별로 메서드/경로를 바꿀 수 있고, REST 콘솔로 실제 응답을 확인할 수 있습니다.
BangDB 서버는 보통 `bangdb.config` 의 `BANGDB_DATABASE_NAME` 하나를 서비스하므로, DB 목록은 앱에 등록된 이름 목록이며 "기존 DB 등록"으로 추가합니다.

## 버전

`npm run build` 를 할 때마다 `prebuild` 가 patch 버전을 하나 올립니다 (`package.json`·`package-lock.json`·`proxy/package.json`, 정보 화면에 표시). CI(`CI` 환경 변수)와 Docker 빌드는 커밋된 버전을 그대로 쓰고, 직접 건너뛰려면 `NO_VERSION_BUMP=1 npm run build` 를 쓰세요. minor·major 는 `package.json` 에서 직접 올립니다.

## 릴리즈

`v*` 태그를 푸시하면 `.github/workflows/release.yml` 이 웹 빌드 zip 과 Android 디버그 APK 를 만들어 GitHub Release 에 첨부합니다.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## 테스트

```bash
npm test            # vitest: 엔드포인트/인증 헤더/클라이언트 호출/응답 파싱, SQL 방언, 게이트웨이 플레이스홀더 변환
node e2e/smoke.mjs ./shots   # Playwright 스모크 (모의 서버 + 프록시 실행 후, 스마트폰 뷰포트)
```

## 구조

```
src/api/        endpoints.ts(템플릿) · http.ts(fetch/CapacitorHttp 래퍼) · bangdb.ts(종류별 분기) · goapi.ts(SQL 접근: BangDB Go + 게이트웨이)
                dialect.ts(SQL 방언) · gateway.ts · mongo.ts
src/store/      연결 목록·요청 기록 (localStorage)
src/pages/      서버 / DB / 테이블 / 테이블 상세 / SQL / REST 콘솔 / 정보, MongoDB·Redis 화면
src/components/ 레이아웃(하단 탭·사이드바), 모달, 토스트, 데이터 그리드, 행 폼, 스키마 폼
proxy/          정적 파일 + CORS 프록시 서버, gateway/ (PostgreSQL·MySQL·SQL Server·SQLite·MongoDB·Redis 어댑터)
scripts/        모의 BangDB 서버
capacitor.config.ts  네이티브 앱 설정
```
