import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, RotateCcw, Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import type { DeviceRole, PairedDevice } from "@devloop/shared";
import { api, queryKeys, type PairingSession } from "../api.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { EmptyState, ErrorPanel, InlineNotice, LoadingPanel } from "../components/feedback.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime } from "../utils.js";

export function DevicesPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [revoking, setRevoking] = useState<PairedDevice | null>(null);
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const local = session.data?.identity.local === true;
  const devices = useQuery({ queryKey: queryKeys.devices, queryFn: api.devices, enabled: local });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.devices });
  };
  const pairingMutation = useMutation({
    mutationFn: () => api.createPairing(externalUrl.trim() || undefined),
    onSuccess: (data) => setPairing(data.pairing),
    onError: (error) => notify(error instanceof Error ? error.message : "配对码生成失败", "danger"),
  });
  const roleMutation = useMutation({
    mutationFn: ({ device, role }: { device: PairedDevice; role: DeviceRole }) =>
      api.updateDevice(device.id, {
        role,
        expectedVersion: device.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await refresh();
      notify("设备权限已更新");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "权限更新失败", "danger"),
  });
  const revokeMutation = useMutation({
    mutationFn: (device: PairedDevice) =>
      api.revokeDevice(device.id, {
        expectedVersion: device.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await refresh();
      setRevoking(null);
      notify("设备已撤销");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "撤销失败", "danger"),
  });

  if (session.isPending) return <LoadingPanel label="正在检查设备权限" />;
  if (!local)
    return <InlineNotice tone="info">设备配对、提权和撤销只能在本机桌面端完成。</InlineNotice>;
  if (devices.isPending) return <LoadingPanel label="正在加载设备" />;
  if (devices.isError) return <ErrorPanel error={devices.error} />;

  return (
    <div className="page-stack devices-layout">
      <section className="tool-panel pairing-panel">
        <div className="section-heading">
          <div>
            <h2>手机配对</h2>
            <span>短时单次使用</span>
          </div>
          <Link2 size={19} />
        </div>
        <label className="field">
          <span>手机访问地址</span>
          <input
            value={externalUrl}
            onChange={(event) => setExternalUrl(event.target.value)}
            placeholder="https://你的设备名.tailnet.ts.net"
          />
        </label>
        <button
          type="button"
          className="button button-primary"
          onClick={() => pairingMutation.mutate()}
          disabled={pairingMutation.isPending}
        >
          <RotateCcw size={17} />
          {pairingMutation.isPending ? "正在生成" : pairing ? "重新生成" : "生成配对码"}
        </button>
        {pairing ? (
          <div className="pairing-result">
            {pairing.url ? (
              <QRCodeSVG value={pairing.url} size={152} level="M" />
            ) : (
              <Smartphone size={48} />
            )}
            <div>
              <small>配对码</small>
              <strong>{pairing.code}</strong>
              <span>有效至 {formatDateTime(pairing.expiresAt)}</span>
            </div>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(pairing.code);
                notify("配对码已复制");
              }}
            >
              <Copy size={17} />
              复制
            </button>
          </div>
        ) : null}
      </section>

      <section className="tool-panel device-list-panel">
        <div className="section-heading">
          <h2>已授权设备</h2>
          <span>{devices.data.devices.filter((device) => !device.revokedAt).length}</span>
        </div>
        {devices.data.devices.length === 0 ? (
          <EmptyState title="还没有配对设备" />
        ) : (
          <div className="device-list">
            {devices.data.devices.map((device) => (
              <div key={device.id} className={`device-row${device.revokedAt ? " revoked" : ""}`}>
                <span className="object-icon">
                  <Smartphone size={18} />
                </span>
                <span className="device-main">
                  <strong>{device.name}</strong>
                  <small>最近在线 {formatDateTime(device.lastSeenAt)}</small>
                </span>
                <select
                  aria-label={`${device.name} 的权限`}
                  value={device.role}
                  disabled={Boolean(device.revokedAt) || roleMutation.isPending}
                  onChange={(event) =>
                    roleMutation.mutate({ device, role: event.target.value as DeviceRole })
                  }
                >
                  <option value="viewer">viewer</option>
                  <option value="operator">operator</option>
                  <option value="editor">editor</option>
                </select>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`撤销 ${device.name}`}
                  disabled={Boolean(device.revokedAt)}
                  onClick={() => setRevoking(device)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="撤销此设备？"
        description="撤销后该设备的 Cookie 将立即失效，需要重新配对。"
        confirmLabel="撤销设备"
        danger
        pending={revokeMutation.isPending}
        onConfirm={() => revoking && revokeMutation.mutate(revoking)}
      />
    </div>
  );
}
