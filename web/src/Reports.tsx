import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import type { Report, ReportMeta, Snapshot } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { dateTime } from './format.ts';
import { Markdown } from './markdown.tsx';

/** 자동 생성된 보고서도 보이도록 목록을 이 주기로 다시 받는다 (가벼운 GET) */
const LIST_POLL_MS = 60_000;

export function Reports() {
  const [list, setList] = useState<ReportMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const wanted = useRef<string | null>(null); // 늦게 도착한 이전 응답을 버리기 위한 표시
  const seenAt = useRef<string | null>(null); // 열린 보고서의 수정 시각. 디스크에서 바뀌면 다시 읽는다
  const jump = useRef(false); // 사용자가 고르거나 생성했을 때만 본문 제목으로 옮겨 간다
  const head = useRef<HTMLHeadingElement>(null);

  const fetchReport = (name: string, onDone?: () => void) =>
    api.report(name).then(
      (r) => {
        if (wanted.current !== name) return;
        setReport(r);
        onDone?.();
      },
      (e: unknown) => {
        if (wanted.current === name) setReportError(errorMessage(e));
      },
    );

  const open = (m: ReportMeta, byUser = true) => {
    wanted.current = m.name;
    seenAt.current = m.modifiedAt;
    jump.current = byUser;
    setSelected(m.name);
    setReport(null);
    setReportError(null);
    setUpdated(false);
    void fetchReport(m.name);
  };

  const loadList = (autoOpen: boolean) =>
    api.reports().then(
      (l) => {
        setList(l);
        setListError(null);
        const first = l[0];
        if (autoOpen && first && wanted.current === null) return open(first, false);
        // 열어 둔 보고서가 그 사이 다시 만들어졌으면 (자동 생성 등) 내용을 다시 읽는다
        const cur = l.find((m) => m.name === wanted.current);
        if (cur && seenAt.current !== null && cur.modifiedAt !== seenAt.current) void fetchReport(cur.name, () => setUpdated(true));
        if (cur) seenAt.current = cur.modifiedAt;
      },
      (e: unknown) => setListError(errorMessage(e)),
    );

  useEffect(() => {
    void loadList(true);
    // 집계 구간(모니터링 시작 시각)과 자동 생성 시각만 쓴다. 실패해도 표시만 빠진다
    api.snapshot().then(setSnap, () => {});
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadList(false);
    };
    const timer = setInterval(refresh, LIST_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []); // 마운트 시 한 번만 건다

  // 고르거나 생성한 결과가 화면 밖(폰에선 목록 아래)에 있어도 보이게 제목으로 포커스를 옮긴다
  useEffect(() => {
    if (!report || !jump.current) return;
    jump.current = false;
    // 이미 보이면 움직이지 않는다. 폰의 떠 있는 상단 띠 아래로 숨지 않게 여백은 CSS scroll-margin 이 맡는다
    head.current?.focus({ preventScroll: true });
    head.current?.scrollIntoView?.({ block: 'nearest' });
  }, [report]);

  const generate = () => {
    // 같은 날 다시 만들면 오늘 파일을 덮어쓴다. 모르고 잃지 않게 한 번 묻는다
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-morning-report.md`;
    if (list?.some((m) => m.name === today) && !window.confirm(`오늘 보고서(${today})가 이미 있습니다. 지금 상태로 다시 만들어 덮어쓸까요?`)) return;
    setGenerating(true);
    setGenError(null);
    api
      .generateReport()
      .then((r) => {
        wanted.current = r.name;
        seenAt.current = null; // 다음 목록에서 새 수정 시각만 기록한다
        jump.current = true;
        setSelected(r.name);
        setReport(r);
        setReportError(null);
        setUpdated(false);
        return loadList(false);
      })
      .catch((e: unknown) => setGenError(errorMessage(e)))
      .finally(() => setGenerating(false));
  };

  return (
    <>
      <span className="eyebrow">SYS.MONITOR // REPORTS</span>
      <div className="detail-head">
        <h1>보고서</h1>
        <button type="button" className="primary" onClick={generate} disabled={generating}>
          {generating ? '생성 중…' : 'Morning Report 생성'}
          <ArrowRight size={14} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <div className="meta">
        {snap && <span>집계 구간: 모니터링 시작 {dateTime(snap.startedAt)} ~ 생성 시점</span>}
        {snap?.autoReportTime && <span>자동 생성 {snap.autoReportTime}</span>}
        <button type="button" onClick={() => void loadList(false)}>
          목록 새로고침
        </button>
      </div>
      {genError && (
        <p className="err" role="alert">
          보고서 생성 실패: {genError}
        </p>
      )}
      <div className="reports">
        <div className="report-list">
          {listError ? (
            <div className="notice error" role="alert">
              <strong>목록을 불러오지 못했습니다.</strong>
              <p>{listError}</p>
              <button type="button" onClick={() => void loadList(true)}>
                다시 시도
              </button>
            </div>
          ) : list === null ? (
            <p className="dim">불러오는 중…</p>
          ) : list.length === 0 ? (
            <p className="dim">저장된 보고서가 없습니다. 위 버튼으로 첫 보고서를 생성하세요.</p>
          ) : (
            <>
              {/* 좁은 화면에선 긴 목록 대신 고르기 상자. 본문이 바로 아래에 온다 */}
              <select
                aria-label="보고서 선택"
                value={selected ?? ''}
                onChange={(e) => {
                  const m = list.find((x) => x.name === e.target.value);
                  if (m) open(m);
                }}
              >
                {selected === null && <option value="">보고서 선택…</option>}
                {list.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} · {dateTime(m.modifiedAt)}
                  </option>
                ))}
              </select>
              <ul>
                {list.map((m) => (
                  <li key={m.name}>
                    <button type="button" aria-current={selected === m.name ? 'true' : undefined} onClick={() => open(m)}>
                      <span className="wrap">{m.name}</span>
                      <span className="dim">{dateTime(m.modifiedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="report-body">
          {reportError ? (
            <div className="notice error" role="alert">
              <strong>보고서를 불러오지 못했습니다.</strong>
              <p>{reportError}</p>
            </div>
          ) : report ? (
            <>
              {updated && (
                <p className="hint" role="status">
                  보고서가 갱신되었습니다.
                </p>
              )}
              <h3 className="wrap with-action" ref={head} tabIndex={-1}>
                {report.name}
                <span className="toggle" role="group" aria-label="보기 방식">
                  <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                    미리보기
                  </button>
                  <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
                    원문
                  </button>
                </span>
              </h3>
              {raw ? (
                <pre className="report-content" tabIndex={0}>
                  {report.content}
                </pre>
              ) : (
                <Markdown source={report.content} />
              )}
            </>
          ) : selected ? (
            <p className="dim">불러오는 중…</p>
          ) : (
            <p className="dim">보고서를 선택하면 내용이 여기에 표시됩니다.</p>
          )}
        </div>
      </div>
    </>
  );
}
