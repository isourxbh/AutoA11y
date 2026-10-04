// Map axe-core rule ids to their WCAG 2.2 success criterion (or best practice).
// Unknown rules resolve to "see helpUrl" so the report stays honest.
export const WCAG_MAP = {
  "image-alt": "1.1.1 Non-text Content",
  "color-contrast": "1.4.3 Contrast (Minimum)",
  label: "1.3.1 Info and Relationships; 4.1.2 Name, Role, Value",
  "select-name": "1.3.1 Info and Relationships; 4.1.2 Name, Role, Value",
  "button-name": "4.1.2 Name, Role, Value",
  "link-name": "2.4.4 Link Purpose (In Context); 4.1.2 Name, Role, Value",
  "page-has-heading-one": "Best practice (relates to 1.3.1 Info and Relationships)",
  "html-has-lang": "3.1.1 Language of Page",
};

export function wcagFor(ruleId) {
  return WCAG_MAP[ruleId] ?? "see helpUrl";
}
