## 미출시 — BangDB (Go) 관리 화면 개편

BangDB (Go) 연결의 화면을 새로 만들었습니다. HTTP API 로 쓸 수 있는 SQL 기능을 모두 화면에서 다룹니다.

- **데이터 그리드**: 셀을 눌러 바로 수정(Enter 다음 행, Tab 다음 칸, Esc 취소), 행 추가·여러 행 삭제, 변경을 모아 한 트랜잭션으로 저장(Ctrl+S, 실패하면 전부 롤백). 숨은 `rowid` 로 행을 식별하므로 기본 키가 없는 테이블, 복합 키, 인메모리·시계열 테이블도 편집됩니다. 정렬, 페이지 이동, 빠른 검색, WHERE 필터. 뷰는 읽기 전용
- **행 폼**: 컬럼 타입별 입력(정수·실수·BOOLEAN 선택·JSON 정렬/검증·BLOB 파일), 기본값/NULL 선택, 행 복제
- **구조**: 컬럼 추가(ALTER TABLE ADD COLUMN, NOT NULL+DEFAULT, COLLATE, UNIQUE 인덱스 동시 생성)·이름 변경·삭제, 테이블 이름 변경·복제·모든 행 삭제·DROP, ANALYZE, 테이블 제약 표시
- **테이블 만들기**: 컬럼별 PRIMARY KEY(복합)·AUTOINCREMENT·NOT NULL·UNIQUE·DEFAULT·COLLATE·CHECK·외래 키(ON DELETE), 테이블 UNIQUE/CHECK, `USING memory`(persist)·`USING timeseries`(time_column, time_unit, retention, block_rows), SQL 미리보기와 직접 편집
- **인덱스**: 컬럼 순서를 골라 (UNIQUE) 인덱스 생성, 삭제, ANALYZE 통계 표시
- **뷰**: 만들기·수정(DROP+CREATE 를 한 트랜잭션으로)·삭제, 미리보기
- **가져오기·내보내기**: CSV/TSV/JSON/JSONL 가져오기(미리보기, 없는 컬럼 제외, INSERT / OR IGNORE / OR REPLACE, 200행 묶음), CSV/JSON/JSONL/SQL 로 전체 또는 조건부 내보내기
- **서버 개요**: 통계 카드(캐시 적중률, WAL, 커밋, API 카운터), VACUUM, ANALYZE, 전체 SQL 덤프(외래 키 순서), SQL 스크립트 실행·복원(BangDB/SQLite 덤프)
- **SQL 콘솔**: 스키마 브라우저, BangDB 기능별 예제 SQL, EXPLAIN / EXPLAIN ANALYZE, 매개변수(`?`, `:name`), 선택 영역만 실행, 결과 CSV/JSON 저장
- 서버 오류 메시지(`{"error"}`)를 그대로 표시, `http://` 없이 입력한 서버 주소 자동 보정

## v0.2.0 — BangDB (Go) 지원

[knoxxr/bangdb](https://github.com/knoxxr/bangdb)(Go 임베디드 관계형 DB)를 관리할 수 있습니다. 서버를 `bangdb -http :18081 -password <pw> app.db` 로 실행하면(`http-api` 브랜치의 JSON HTTP API) 브라우저·스마트폰에서 프록시 없이 직접 연결됩니다.

- 서버 연결에 **종류** 선택 추가: BangDB (Go) HTTP API(기본) / BangDB 2.0 REST
- Go 서버: 테이블 생성 컬럼 빌더(타입·PK·NOT NULL·UNIQUE·DEFAULT, SQL 직접 편집), 행 입력(INSERT), 행 수정/삭제(기본 키 기준 UPDATE/DELETE), 키 조회/삭제, 인덱스 목록·CREATE/DROP INDEX, 테이블 정보(컬럼·PK·정의 SQL), SQL 콘솔, 서버 상태(/v1/stats), 대량 가져오기(INSERT)
- 결과가 서버 행 수 제한으로 잘리면 표시
- 첨부 파일은 v0.1.0 과 같은 구성(웹 번들 zip, Android 디버그 APK)

## v0.1.0 — 첫 릴리즈

BangDB 데이터베이스·테이블 관리용 크로스플랫폼 앱 (웹 / PWA / Android).

**첨부 파일**
- `bangdb-manager-web-v0.1.0.zip` — 웹 빌드 + CORS 프록시. 압축 해제 후 `BANGDB_URL=http://<BangDB 주소>:18080 node proxy/server.mjs` 실행, 브라우저에서 `http://localhost:8080` 접속 (Node.js 20+ 필요). 스마트폰은 같은 네트워크에서 `http://<PC IP>:8080` 으로 접속해 홈 화면에 추가하면 됩니다.
- `bangdb-manager-v0.1.0-android-debug.apk` — Android 디버그 빌드. 설치 시 "알 수 없는 출처" 허용 필요. 네이티브 HTTP 로 BangDB 에 직접 연결하므로 프록시가 필요 없습니다.

**기능**
- 서버 연결 여러 개 저장, 인증 4가지(없음 / API 키 헤더 / 로그인 토큰 / HTTP Basic), 연결 테스트
- DB 생성·DROP·등록, 서버 상태 조회
- 테이블 목록·생성(WIDE/NORMAL, 키 옵션)·삭제
- 테이블 상세: 행 수, SQL 조회(표/JSON), 행 터치로 수정·삭제, JSON/CSV 내보내기, JSON/JSONL 대량 가져오기, 문서 입력, 키 조회/삭제, 인덱스 추가/삭제
- SQL 콘솔(히스토리), REST 콘솔(요청 기록)
- 모바일 하단 탭 / 데스크톱 사이드바, 다크·라이트 테마, 오프라인 캐시(PWA)

**알려진 제한**
- BangDB 공식 문서로 확인된 REST 경로는 테이블 목록/생성, 행 수, 인덱스 추가, 문서 입력, SQL 질의입니다. 나머지(테이블 삭제, 키 조회·삭제, DB 생성·삭제, 로그인, 서버 상태)는 추정 경로이며 서버 연결 편집 → 고급에서 수정할 수 있습니다.
- iOS 는 소스에서 `npm run cap:ios` 로 Xcode 프로젝트를 생성해 빌드해야 합니다.
