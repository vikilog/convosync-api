import { z } from 'zod';

export const mediaGalleryScopeSchema = z.enum(['customer', 'partner', 'both']);
export const mediaGalleryTypeSchema = z.enum(['image', 'pdf', 'video', 'audio', 'document']);

export const mediaGalleryUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(8000).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  scope: mediaGalleryScopeSchema.optional(),
  usage: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  type: mediaGalleryTypeSchema.optional(),
  isActive: z.boolean().optional(),
  filename: z.string().min(1).max(255).optional(),
  url: z.string().url().optional(),
});
