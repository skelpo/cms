// Menu read/write + tree assembly. Menus are small structures read on
// nearly every page render — kept in-memory after first load, refreshed
// on writes.

import { execute, query, queryOne } from '../db/client.js';

export interface MenuRow {
  id: number;
  slug: string;
  label: string;
  isBuiltin: number;
}

export interface MenuItemDbRow {
  id: number;
  menuId: number;
  parentId: number | null;
  label: string | Record<string, string>;
  url: string | null;
  contentId: number | null;
  target: '_self' | '_blank';
  sortOrder: number;
}

export interface MenuItemTree {
  id: number;
  label: string;
  url: string | null;
  contentId: number | null;
  target: '_self' | '_blank';
  sortOrder: number;
  children: MenuItemTree[];
}

function parseLabels(v: string | Record<string, string>): Record<string, string> {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) as Record<string, string>; } catch { return { en: v }; }
}

function resolveLabel(labels: Record<string, string>, locale: string, defaultLocale: string): string {
  return labels[locale] ?? labels[defaultLocale] ?? Object.values(labels)[0] ?? '';
}

export async function listMenus(): Promise<MenuRow[]> {
  return query<MenuRow>('SELECT `id`, `slug`, `label`, `isBuiltin` FROM `menus` ORDER BY `id`');
}

export async function getMenuBySlug(slug: string): Promise<MenuRow | null> {
  return queryOne<MenuRow>('SELECT * FROM `menus` WHERE `slug` = ?', [slug]);
}

export async function getMenuTree(
  slug: string,
  locale: string,
  defaultLocale: string,
): Promise<{ menu: MenuRow; items: MenuItemTree[] } | null> {
  const menu = await getMenuBySlug(slug);
  if (!menu) return null;

  // Fetch all items in one query — tree assembled in-memory.
  // Also resolve content URLs for items linked via contentId.
  const items = await query<MenuItemDbRow & { contentSlug?: string; contentLocale?: string; contentTypeSlug?: string }>(
    `SELECT
        mi.\`id\`, mi.\`menuId\`, mi.\`parentId\`, mi.\`label\`,
        mi.\`url\`, mi.\`contentId\`, mi.\`target\`, mi.\`sortOrder\`,
        c.\`slug\`     AS \`contentSlug\`,
        c.\`locale\`   AS \`contentLocale\`,
        c.\`typeSlug\` AS \`contentTypeSlug\`
       FROM \`menuItems\` mi
       LEFT JOIN \`content\` c ON c.\`id\` = mi.\`contentId\`
      WHERE mi.\`menuId\` = ?
      ORDER BY mi.\`parentId\` ASC, mi.\`sortOrder\` ASC, mi.\`id\` ASC`,
    [menu.id],
  );

  const byParent = new Map<number | null, MenuItemTree[]>();
  for (const r of items) {
    const labels = parseLabels(r.label);
    const tree: MenuItemTree = {
      id: r.id,
      label: resolveLabel(labels, locale, defaultLocale),
      url: r.url ?? null,
      contentId: r.contentId,
      target: r.target,
      sortOrder: r.sortOrder,
      children: [],
    };
    let arr = byParent.get(r.parentId);
    if (!arr) {
      arr = [];
      byParent.set(r.parentId, arr);
    }
    arr.push(tree);
  }
  // Attach children recursively.
  const attach = (n: MenuItemTree): void => {
    n.children = byParent.get(n.id) ?? [];
    for (const child of n.children) attach(child);
  };
  const roots = byParent.get(null) ?? [];
  for (const r of roots) attach(r);
  return { menu, items: roots };
}

// ────────────────────────────────────────────────────────────────────────
// Writes
// ────────────────────────────────────────────────────────────────────────

export async function createMenu(input: { slug: string; label: string }): Promise<MenuRow> {
  const r = await execute(
    'INSERT INTO `menus` (`slug`, `label`, `isBuiltin`) VALUES (?, ?, 0)',
    [input.slug, input.label],
  );
  const row = await queryOne<MenuRow>('SELECT * FROM `menus` WHERE `id` = ?', [r.insertId]);
  if (!row) throw new Error('Created menu disappeared');
  return row;
}

export async function updateMenu(slug: string, patch: { label?: string }): Promise<MenuRow | null> {
  if (patch.label !== undefined) {
    await execute('UPDATE `menus` SET `label` = ? WHERE `slug` = ?', [patch.label, slug]);
  }
  return getMenuBySlug(slug);
}

export async function deleteMenu(slug: string): Promise<boolean> {
  const r = await execute('DELETE FROM `menus` WHERE `slug` = ? AND `isBuiltin` = 0', [slug]);
  return r.affectedRows > 0;
}

export interface MenuItemInput {
  parentId?: number | null;
  label: Record<string, string>;
  url?: string | null;
  contentId?: number | null;
  target?: '_self' | '_blank';
  sortOrder?: number;
}

export async function addMenuItem(menuSlug: string, input: MenuItemInput): Promise<number> {
  const menu = await getMenuBySlug(menuSlug);
  if (!menu) throw new Error(`Menu not found: ${menuSlug}`);
  // App-level mutex of url vs contentId — DB CHECK was removed for FK compat.
  if (input.url && input.contentId) {
    throw new Error('Provide either url or contentId, not both');
  }
  const r = await execute(
    `INSERT INTO \`menuItems\`
      (\`menuId\`, \`parentId\`, \`label\`, \`url\`, \`contentId\`, \`target\`, \`sortOrder\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      menu.id,
      input.parentId ?? null,
      JSON.stringify(input.label),
      input.url ?? null,
      input.contentId ?? null,
      input.target ?? '_self',
      input.sortOrder ?? 0,
    ],
  );
  return Number(r.insertId);
}

export async function updateMenuItem(
  itemId: number,
  patch: Partial<MenuItemInput>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.parentId !== undefined) { sets.push('`parentId` = ?'); params.push(patch.parentId); }
  if (patch.label    !== undefined) { sets.push('`label` = ?');    params.push(JSON.stringify(patch.label)); }
  if (patch.url      !== undefined) { sets.push('`url` = ?');      params.push(patch.url); }
  if (patch.contentId !== undefined){ sets.push('`contentId` = ?');params.push(patch.contentId); }
  if (patch.target   !== undefined) { sets.push('`target` = ?');   params.push(patch.target); }
  if (patch.sortOrder !== undefined){ sets.push('`sortOrder` = ?');params.push(patch.sortOrder); }
  if (sets.length === 0) return;
  params.push(itemId);
  await execute(`UPDATE \`menuItems\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);
}

export async function deleteMenuItem(itemId: number): Promise<boolean> {
  const r = await execute('DELETE FROM `menuItems` WHERE `id` = ?', [itemId]);
  return r.affectedRows > 0;
}

export async function reorderMenuItems(items: Array<{ id: number; parentId: number | null; sortOrder: number }>): Promise<void> {
  for (const it of items) {
    await execute(
      'UPDATE `menuItems` SET `parentId` = ?, `sortOrder` = ? WHERE `id` = ?',
      [it.parentId, it.sortOrder, it.id],
    );
  }
}
