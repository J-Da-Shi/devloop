import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Smartphone } from "lucide-react";
import { useState } from "react";
import { api, queryKeys } from "../api.js";
import { InlineNotice } from "../components/feedback.js";

export function PairPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("我的手机");
  const pair = useMutation({
    mutationFn: api.pair,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
      await navigate({ to: "/status" });
    },
  });

  return (
    <main className="pair-page">
      <section className="pair-shell">
        <div className="pair-brand">
          <img src="/devloop-mark.svg" alt="DevLoop" width="42" height="42" />
          <strong>DevLoop</strong>
        </div>
        <div className="pair-heading">
          <span>
            <Smartphone size={22} />
          </span>
          <div>
            <h1>配对手机</h1>
            <p>输入桌面端生成的 6 位配对码</p>
          </div>
        </div>
        {pair.isError ? (
          <InlineNotice tone="danger">
            {pair.error instanceof Error ? pair.error.message : "配对失败"}
          </InlineNotice>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            pair.mutate({ code, name });
          }}
          className="form-stack"
        >
          <label className="field">
            <span>设备名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
          </label>
          <label className="field">
            <span>配对码</span>
            <input
              className="pair-code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              pattern="\d{6}"
              autoComplete="one-time-code"
              required
            />
          </label>
          <button
            type="submit"
            className="button button-primary button-wide"
            disabled={pair.isPending || code.length !== 6 || !name.trim()}
          >
            {pair.isPending ? "正在配对" : "完成配对"}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}
