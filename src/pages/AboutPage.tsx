import { Capacitor } from '@capacitor/core';
import { DEFAULT_ENDPOINTS, ENDPOINT_KEYS } from '../api/endpoints';
import { TopBar } from '../components/Layout';

export default function AboutPage() {
  const platform = Capacitor.getPlatform();
  const standalone = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  return (
    <>
      <TopBar title="정보" />
      <div className="card">
        <p><b>BangDB Manager</b> v{__APP_VERSION__}</p>
        <p className="muted small">실행 환경: {platform}{standalone ? ' (설치된 PWA)' : ''}</p>
        <p className="small">BangDB 2.0 REST API(기본 포트 18080)를 통해 데이터베이스와 테이블을 생성·조회·삭제하고, 문서 입력/조회와 SQL 질의를 실행하는 크로스플랫폼 관리 도구입니다. 연결 정보는 이 기기의 브라우저 저장소에만 보관됩니다.</p>
      </div>
      <div className="card">
        <b>스마트폰에 설치</b>
        <ul className="small">
          <li>Android Chrome: 메뉴 → "홈 화면에 추가" (PWA)</li>
          <li>iOS Safari: 공유 → "홈 화면에 추가"</li>
          <li>네이티브 앱: 저장소의 README 대로 <code>npm run cap:android</code> / <code>npm run cap:ios</code> 로 빌드</li>
        </ul>
      </div>
      <div className="card">
        <b>사용 중인 REST 엔드포인트 (기본값)</b>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table className="data">
            <thead><tr><th>키</th><th>메서드</th><th>경로</th><th>문서 확인</th></tr></thead>
            <tbody>
              {ENDPOINT_KEYS.map((k) => {
                const e = DEFAULT_ENDPOINTS[k];
                return <tr key={k}><td className="mono">{k}</td><td>{e.method}</td><td className="mono">{e.path}</td><td>{e.verified ? <span className="ok">✔</span> : <span className="warn">추정</span>}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">"추정" 항목은 서버 연결 편집 → 고급 에서 수정할 수 있습니다.</p>
      </div>
    </>
  );
}
