import { Prisma } from '@prisma/client';
import type { EmailRepository } from '../repositories/email.repository.js';
import {
  applyTemplateVariables,
  extractTemplateVariables,
  stripHtmlToText,
} from '../utils/template-variables.js';
import type { UpsertEmailTemplateDto, UpdateEmailTemplateDto } from '../dto/email.dto.js';
import { generateEmailTemplateContent } from './email-template-ai.service.js';

function toJsonInput(value: Record<string, unknown> | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export class EmailTemplateService {
  constructor(private readonly repo: EmailRepository) {}

  listTemplates(workspaceId: string) {
    return this.repo.listEmailTemplates(workspaceId);
  }

  getTemplate(workspaceId: string, id: string) {
    return this.repo.findEmailTemplateById(workspaceId, id);
  }

  async createTemplate(workspaceId: string, input: UpsertEmailTemplateDto) {
    const name = input.name.toLowerCase().trim();
    const existing = await this.repo.findEmailTemplateByName(workspaceId, name);
    if (existing) throw new Error('Email template name already exists');

    const variables = extractTemplateVariables(input.subject, input.htmlBody);
    const textBody = input.textBody?.trim() || stripHtmlToText(input.htmlBody);

    return this.repo.createEmailTemplate({
      name,
      subject: input.subject.trim(),
      htmlBody: input.htmlBody,
      textBody,
      variables,
      status: input.status ?? 'draft',
      ...(input.designJson !== undefined ? { designJson: toJsonInput(input.designJson) } : {}),
      workspace: { connect: { id: workspaceId } },
    });
  }

  async updateTemplate(workspaceId: string, id: string, input: UpdateEmailTemplateDto) {
    const row = await this.repo.findEmailTemplateById(workspaceId, id);
    if (!row) throw new Error('Email template not found');

    if (input.name && input.name.toLowerCase() !== row.name) {
      const clash = await this.repo.findEmailTemplateByName(workspaceId, input.name.toLowerCase());
      if (clash && clash.id !== id) throw new Error('Email template name already exists');
    }

    const subject = input.subject?.trim() ?? row.subject;
    const htmlBody = input.htmlBody ?? row.htmlBody;
    const textBody =
      input.textBody !== undefined
        ? input.textBody.trim() || stripHtmlToText(htmlBody)
        : row.textBody ?? stripHtmlToText(htmlBody);

    return this.repo.updateEmailTemplate(id, {
      ...(input.name ? { name: input.name.toLowerCase().trim() } : {}),
      ...(input.subject !== undefined ? { subject } : {}),
      ...(input.htmlBody !== undefined ? { htmlBody } : {}),
      textBody,
      variables: extractTemplateVariables(subject, htmlBody),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.designJson !== undefined ? { designJson: toJsonInput(input.designJson) } : {}),
    });
  }

  async deleteTemplate(workspaceId: string, id: string) {
    const row = await this.repo.findEmailTemplateById(workspaceId, id);
    if (!row) throw new Error('Email template not found');
    await this.repo.deleteEmailTemplate(id);
  }

  async renderTemplate(
    workspaceId: string,
    templateId: string,
    variables: Record<string, string> = {}
  ) {
    const row = await this.repo.findEmailTemplateById(workspaceId, templateId);
    if (!row) throw new Error('Email template not found');
    if (row.status !== 'active') {
      throw new Error('Email template is not active');
    }

    const html = applyTemplateVariables(row.htmlBody, variables);
    // Always derive text from rendered HTML — persisted textBody can be stale
    // (collapsed whitespace / literal &nbsp; from older stripHtmlToText).
    return {
      subject: applyTemplateVariables(row.subject, variables),
      html,
      text: stripHtmlToText(html),
      templateName: row.name,
    };
  }

  async generateWithAi(prompt: string) {
    return generateEmailTemplateContent(prompt);
  }
}
