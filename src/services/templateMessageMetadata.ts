/**
 * Presentation metadata stamped onto a sent template Message row so the inbox
 * bubble can render it like the actual WhatsApp template (header image/text,
 * footer, buttons) without a live lookup against the Template record — a
 * template can be edited or deleted after the message was sent, but what was
 * actually sent should stay stable.
 */

type TemplateForMetadata = {
  header: string | null;
  headerFormat: string | null;
  headerMediaStorageKey: string | null;
  headerMediaMimeType: string | null;
  headerMediaFileName: string | null;
  footer: string | null;
  buttonType: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  buttonPhoneNumber: string | null;
};

export function templateMessagePresentationMetadata(template: TemplateForMetadata) {
  return {
    headerFormat: template.headerFormat ?? null,
    header: template.header ?? null,
    headerMediaStorageKey: template.headerMediaStorageKey ?? null,
    headerMediaMimeType: template.headerMediaMimeType ?? null,
    headerMediaFileName: template.headerMediaFileName ?? null,
    footer: template.footer ?? null,
    buttonType: template.buttonType ?? null,
    buttonText: template.buttonText ?? null,
    buttonUrl: template.buttonUrl ?? null,
    buttonPhoneNumber: template.buttonPhoneNumber ?? null,
  };
}
