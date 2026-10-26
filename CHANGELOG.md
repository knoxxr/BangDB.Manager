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
