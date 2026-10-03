import { useEffect, useRef, useState } from 'react';
import type { Report, ReportMeta } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { dateTime } from './format.ts';

export function Reports() {
  const [list, setList] = useState<ReportMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const wanted = useRef<string | null>(null); // 늦게 도착한 이전 응답을 버리기 위한 표시

  const open = (name: string) => {
    wanted.current = name;
    setSelected(name);
    setReport(null);
    setReportError(null);
    api.report(name).then(
      (r) => {
        if (wanted.current === name) setReport(r);
      },
      (e: unknown) => {
        if (wanted.current === name) setReportError(errorMessage(e));
      },
    );
  };

  const loadList = (autoOpen: boolean) =>
    api.reports().then(
      (l) => {
        setList(l);
        setListError(null);
        const first = l[0];
        if (autoOpen && first && wanted.current === null) open(first.name);
      },
      (e: unknown) => setListError(errorMessage(e)),
    );

  useEffect(() => {
    void loadList(true);
  }, []); // 마운트 시 한 번만 불러온다

  const generate = () => {
    setGenerating(true);
    setGenError(null);
    api
      .generateReport()
      .then((r) => {
        wanted.current = r.name;
        setSelected(r.name);
        setReport(r);
        setReportError(null);
        return loadList(false);
      })
      .catch((e: unknown) => setGenError(errorMessage(e)))
      .finally(() => setGenerating(false));
  };

  return (
    <>
      <div className="detail-head">
        <h1>보고서</h1>
        <button type="button" className="primary" onClick={generate} disabled={generating}>
          {generating ? '생성 중…' : 'Morning Report 생성'}
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
            <ul>
              {list.map((m) => (
                <li key={m.name}>
                  <button type="button" aria-current={selected === m.name ? 'true' : undefined} onClick={() => open(m.name)}>
                    <span className="wrap">{m.name}</span>
                    <span className="dim">{dateTime(m.modifiedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
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
              <h3 className="wrap">{report.name}</h3>
              <pre className="report-content" tabIndex={0}>
                {report.content}
              </pre>
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
