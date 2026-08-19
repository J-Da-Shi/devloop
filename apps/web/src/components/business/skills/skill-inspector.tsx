import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  History,
  LoaderCircle,
} from "lucide-react";
import { Flex } from "antd";
import type { SkillDetails, SkillValidationResult } from "@devloop/shared";
import { formatDateTime } from "../../../core/index.js";
import type { SkillValidationState } from "../../../types/index.js";

interface SkillInspectorProps {
  canEdit: boolean;
  isCreating: boolean;
  validationState: SkillValidationState;
  validation: SkillValidationResult | null;
  details: SkillDetails | undefined;
  currentVersionId: string | null;
}

export function SkillInspector({
  canEdit,
  isCreating,
  validationState,
  validation,
  details,
  currentVersionId,
}: SkillInspectorProps) {
  return (
    <div className="skill-inspector">
      <section className="skill-validation-panel">
        <div className="skill-inspector-heading">
          <span>
            <CheckCircle2 size={16} aria-hidden="true" />
            校验结果
          </span>
          {validation?.contentHash ? <code>{validation.contentHash.slice(0, 12)}</code> : null}
        </div>
        {!canEdit ? (
          <div className="skill-inspector-empty">已发布内容</div>
        ) : validationState !== "idle" ? (
          <div className="skill-inspector-empty">
            <LoaderCircle className="spin" size={16} /> 正在检查内容
          </div>
        ) : !validation ? (
          <div className="skill-inspector-empty">等待内容校验</div>
        ) : validation.issues.length === 0 ? (
          <div className="skill-validation-ok">
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>
              <strong>{validation.name}</strong>
              <small>{validation.description}</small>
            </span>
          </div>
        ) : (
          <Flex vertical className="skill-issue-list">
            {validation.issues.map((issue) => (
              <div key={`${issue.code}-${issue.message}`} className={issue.severity}>
                {issue.severity === "error" ? (
                  <CircleAlert size={16} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={16} aria-hidden="true" />
                )}
                <span>
                  <strong>{issue.code}</strong>
                  <small>{issue.message}</small>
                </span>
              </div>
            ))}
          </Flex>
        )}
      </section>
      <section className="skill-history-panel">
        <div className="skill-inspector-heading">
          <span>
            <History size={16} aria-hidden="true" />
            版本历史
          </span>
          <span>{details?.versions.length ?? 0}</span>
        </div>
        {isCreating ? (
          <div className="skill-inspector-empty">创建后生成 v1</div>
        ) : (
          <Flex vertical className="skill-version-list">
            {details?.versions.map((version) => (
              <div
                key={version.id}
                className={`skill-version-row${version.id === currentVersionId ? " current" : ""}`}
              >
                <span className="skill-version-number">v{version.version}</span>
                <span>
                  <code>{version.contentHash.slice(0, 10)}</code>
                  <small>
                    <Clock3 size={12} aria-hidden="true" />
                    {formatDateTime(version.createdAt)}
                  </small>
                </span>
                {version.id === currentVersionId ? <strong>当前</strong> : null}
              </div>
            ))}
          </Flex>
        )}
      </section>
    </div>
  );
}
