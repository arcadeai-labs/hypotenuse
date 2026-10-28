import { SectionNav, type SectionNavItem } from "../sections/SectionNav";
import { SETTINGS_SECTIONS } from "./sections";

/**
 * The project settings sidebar: {@link SETTINGS_SECTIONS} mapped onto
 * `SectionNav`'s items. Every section is a link for every member; what a
 * section lets a person change is decided inside it.
 * @returns The sidebar.
 */
export function SettingsSectionNav() {
  const items: SectionNavItem[] = SETTINGS_SECTIONS.map((section) => ({
    slug: section.slug,
    label: section.label,
    group: section.group,
    to: `/settings/${section.slug}`,
  }));
  return <SectionNav testId="settings-section-nav" items={items} />;
}
