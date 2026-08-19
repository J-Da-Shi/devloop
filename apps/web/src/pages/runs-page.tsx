import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, queryKeys } from "../core/index.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/common/index.js";
import { RunDetail, RunList } from "../components/business/runs/index.js";

export function RunsPage() {
  const runs = useQuery({ queryKey: queryKeys.runs, queryFn: api.runs });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && runs.data?.runs[0]) {
      setSelectedId(runs.data.runs[0].id);
    }
  }, [runs.data?.runs, selectedId]);

  const details = useQuery({
    queryKey: queryKeys.run(selectedId ?? "none"),
    queryFn: () => api.run(selectedId ?? ""),
    enabled: Boolean(selectedId),
  });

  if (runs.isPending) return <LoadingPanel label="正在加载执行记录" />;
  if (runs.isError) return <ErrorPanel error={runs.error} />;
  if (runs.data.runs.length === 0) return <EmptyState title="还没有执行记录" />;

  return (
    <div className="runs-layout">
      <RunList runs={runs.data.runs} selectedId={selectedId} onSelect={setSelectedId} />
      <section className="tool-panel run-detail-panel">
        {details.isPending ? <LoadingPanel label="正在加载执行详情" /> : null}
        {details.isError ? <ErrorPanel error={details.error} /> : null}
        {details.data ? <RunDetail details={details.data} /> : null}
      </section>
    </div>
  );
}
