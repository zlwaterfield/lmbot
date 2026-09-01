/**
 * The category knowledge base: the single source of truth for what lmbot is
 * allowed to assign. Built once per run from GET /categories and shared by the
 * rules engine, the memory tier, and the LLM prompt.
 */

export class CategoryKB {
  constructor(categories) {
    this.all = categories;
    // Only leaf categories are assignable — a transaction can't live on a group.
    this.assignable = categories.filter((c) => !c.is_group && !c.archived);
    this.byId = new Map(categories.map((c) => [c.id, c]));

    this.byName = new Map();
    for (const cat of this.assignable) {
      const key = cat.name.trim().toLowerCase();
      if (!this.byName.has(key)) this.byName.set(key, cat);
    }
  }

  static async load(lm) {
    return new CategoryKB(await lm.getCategories({ format: 'flattened' }));
  }

  groupName(cat) {
    if (cat.group_id == null) return null;
    return this.byId.get(cat.group_id)?.name ?? null;
  }

  /** Full display path, e.g. "Food & Drink > Coffee Shops". */
  path(cat) {
    const group = this.groupName(cat);
    return group ? `${group} > ${cat.name}` : cat.name;
  }

  label(id) {
    if (id == null) return '—';
    const cat = this.byId.get(id);
    return cat ? this.path(cat) : `#${id}`;
  }

  isAssignable(id) {
    const cat = this.byId.get(id);
    return Boolean(cat && !cat.is_group && !cat.archived);
  }

  /**
   * Resolve a user-written category reference from rules.json. Accepts a numeric
   * id, an exact name, or a "Group > Name" path. Case-insensitive.
   */
  resolve(ref) {
    if (ref == null) return null;
    if (typeof ref === 'number') return this.isAssignable(ref) ? ref : null;

    const raw = String(ref).trim();
    if (/^\d+$/.test(raw)) return this.isAssignable(Number(raw)) ? Number(raw) : null;

    const leaf = raw.includes('>') ? raw.split('>').pop().trim() : raw;
    const hit = this.byName.get(leaf.toLowerCase());
    if (hit) return hit.id;

    // Fall back to a unique case-insensitive path match.
    const matches = this.assignable.filter(
      (cat) => this.path(cat).toLowerCase() === raw.toLowerCase()
    );
    return matches.length === 1 ? matches[0].id : null;
  }

  /**
   * The prompt block handed to the LLM. Grouped, with the flags that actually
   * change the answer (income vs expense) spelled out.
   */
  toPrompt() {
    const grouped = new Map();
    for (const cat of this.assignable) {
      const group = this.groupName(cat) ?? 'Ungrouped';
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(cat);
    }

    const lines = [];
    for (const group of [...grouped.keys()].sort()) {
      lines.push(`\n## ${group}`);
      for (const cat of grouped.get(group).sort((a, b) => a.name.localeCompare(b.name))) {
        const flags = [];
        if (cat.is_income) flags.push('INCOME');
        if (cat.exclude_from_budget) flags.push('excluded from budget');
        if (cat.exclude_from_totals) flags.push('excluded from totals');
        let line = `- id=${cat.id} | ${cat.name}`;
        if (cat.description) line += ` — ${cat.description}`;
        if (flags.length) line += ` [${flags.join(', ')}]`;
        lines.push(line);
      }
    }
    return lines.join('\n').trim();
  }

  summary() {
    const groups = new Set(this.assignable.map((c) => this.groupName(c)).filter(Boolean));
    const archived = this.all.filter((c) => c.archived).length;
    return {
      assignable: this.assignable.length,
      groups: groups.size,
      archived,
      income: this.assignable.filter((c) => c.is_income).length,
    };
  }
}
