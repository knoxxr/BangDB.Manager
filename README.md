# BangDB Manager

BangDB 서버의 데이터베이스·테이블을 생성/조회/삭제하고, 문서 입력과 SQL 질의를 실행하는 **크로스플랫폼 관리 앱**입니다.
하나의 코드베이스로 다음 환경에서 동작합니다.

| 환경 | 방법 |
|------|------|
| 데스크톱 브라우저 (Windows/macOS/Linux) | 빌드된 웹앱을 열기 |
| 스마트폰 브라우저 → 홈 화면 설치 (PWA) | Android Chrome "홈 화면에 추가", iOS Safari "홈 화면에 추가" |
| Android / iOS 네이티브 앱 | Capacitor 로 래핑 (`npm run cap:android` / `npm run cap:ios`) |
| 서버 배포 | `Dockerfile` (정적 파일 + CORS 프록시) |

BangDB 2.0 REST API(기본 포트 **18080**)만 사용하므로 서버 쪽 추가 설치가 필요 없습니다.

## 기능

- 서버 연결 여러 개 저장 (이름, URL, 기본 DB, 인증 방식: 없음 / API 키 헤더 / 로그인 토큰 / HTTP Basic)
- 연결 테스트
- 데이터베이스: 생성(`createDb`), DROP, 기존 DB 등록, 테이블 수 확인
- 테이블: 목록(시스템 테이블 숨김/표시, 검색), 생성(WIDE/NORMAL, 키 유형/크기, 중복·역인덱스·버전 옵션), 삭제
- 테이블 상세: 행 수, SQL 기반 데이터 조회(테이블/JSON 보기), 행 터치 → 문서 수정/삭제, JSON·CSV 내보내기, JSON/JSONL 대량 가져오기(진행률, 오류 시 중단), 문서 입력(`_pk`), 키 조회/삭제, 인덱스 추가/삭제, 테이블 정보
- 서버 상태 조회(`serverStats`)
- SQL 콘솔 (히스토리, Ctrl+Enter)
- REST 콘솔 (임의 메서드/경로/본문 + 최근 요청 기록)
- 모바일 하단 탭 / 데스크톱 사이드바, 다크·라이트 자동, 오프라인 캐시(PWA)

연결 정보는 기기의 브라우저 저장소(localStorage)에만 저장됩니다.

## 빠른 시작 (개발)

```bash
npm install
BANGDB_URL=http://192.168.0.10:18080 npm run dev   # http://localhost:5173
```

개발 서버는 `/bangdb/*` 를 `BANGDB_URL` 로 전달합니다. 연결 추가 시 **"프록시 경유"** 를 켜면 CORS 없이 동작합니다.
같은 Wi-Fi 의 스마트폰에서는 `http://<PC IP>:5173` 으로 접속하면 됩니다.

BangDB 가 없을 때는 모의 서버로 UI를 확인할 수 있습니다.

```bash
node scripts/mock-bangdb.mjs          # 18080 포트에 모의 BangDB
```

## 배포 (웹/PWA)

```bash
npm run build                                   # dist/
BANGDB_URL=http://192.168.0.10:18080 npm run proxy   # http://0.0.0.0:8080 에서 dist + /bangdb 프록시
```

또는 Docker:

```bash
docker build -t bangdb-manager .
docker run -p 8080:8080 -e BANGDB_URL=http://192.168.0.10:18080 bangdb-manager
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

## REST 엔드포인트와 검증 상태

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

## 테스트

```bash
npm test            # vitest: 엔드포인트/인증 헤더/클라이언트 호출/응답 파싱
node e2e/smoke.mjs ./shots   # Playwright 스모크 (모의 서버 + 프록시 실행 후, 스마트폰 뷰포트)
```

## 구조

```
src/api/        endpoints.ts(템플릿) · http.ts(fetch/CapacitorHttp 래퍼) · bangdb.ts(클라이언트)
src/store/      연결 목록·요청 기록 (localStorage)
src/pages/      서버 / DB / 테이블 / 테이블 상세 / SQL / REST 콘솔 / 정보
src/components/ 레이아웃(하단 탭·사이드바), 모달, 토스트, 데이터 테이블
proxy/          정적 파일 + CORS 프록시 서버
scripts/        모의 BangDB 서버
capacitor.config.ts  네이티브 앱 설정
```
