import { Badge, Button, Input, Tag } from "antd";
import { Plus, Search } from "lucide-react";
import type { Skill } from "@devloop/shared";

interface SkillRegistryProps {
  skills: Skill[];
  totalCount: number;
  selectedSkillId: string | null;
  search: string;
  canEdit: boolean;
  onSearch(value: string): void;
  onSelect(target: string | "new"): void;
}

export function SkillRegistry({
  skills,
  totalCount,
  selectedSkillId,
  search,
  canEdit,
  onSearch,
  onSelect,
}: SkillRegistryProps) {
  return (
    <section className="skill-registry tool-panel" aria-label="Skill 列表">
      <div className="skill-registry-heading">
        <div>
          <span className="skill-section-kicker">REGISTRY</span>
          <h2>Skill</h2>
        </div>
        <Tag variant="filled" className="skill-count">
          {totalCount}
        </Tag>
      </div>
      <Input
        className="skill-search"
        aria-label="搜索 Skill"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="搜索名称或描述"
        prefix={<Search size={16} aria-hidden="true" />}
        allowClear
      />
      <div className="skill-list">
        {skills.length === 0 ? (
          <div className="skill-list-empty">{search ? "没有匹配结果" : "暂无 Skill"}</div>
        ) : (
          skills.map((skill) => (
            <Button
              key={skill.id}
              type="text"
              block
              className={`skill-list-item${selectedSkillId === skill.id ? " active" : ""}`}
              aria-pressed={selectedSkillId === skill.id}
              onClick={() => onSelect(skill.id)}
            >
              <Badge status={skill.enabled ? "success" : "default"} className="skill-state-dot" />
              <span className="skill-list-copy">
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
              </span>
              <code>v{skill.currentVersion}</code>
            </Button>
          ))
        )}
      </div>
      {canEdit ? (
        <Button
          className="skill-create-button"
          icon={<Plus size={17} aria-hidden="true" />}
          onClick={() => onSelect("new")}
        >
          新建 Skill
        </Button>
      ) : (
        <div className="skill-readonly-note">当前实例为只读权限</div>
      )}
    </section>
  );
}
