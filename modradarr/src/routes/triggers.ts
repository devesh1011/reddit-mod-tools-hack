import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentDeleteRequest,
  OnCommentSubmitRequest,
  OnCommentUpdateRequest,
  OnPostDeleteRequest,
  OnPostSubmitRequest,
  OnPostUpdateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { handleDelete, handleSubmit, handleUpdate } from '../core/edit-radar';
import { writeDefaultSettings } from '../core/redis-schema';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('App installed to subreddit: r/' + input.subreddit?.name);
  try {
    await writeDefaultSettings();
  } catch (err) {
    console.error('[modradar] writeDefaultSettings failed', err);
  }
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  const post = input.post;
  const author = input.author;
  if (!post?.id) return c.json<TriggerResponse>({ status: 'success' }, 200);

  await handleSubmit({
    type: 'post',
    thingId: post.id,
    body: combinePostBody(post),
    authorId: author?.id,
    authorName: author?.name,
    permalink: post.permalink,
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : undefined,
  });

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-comment-submit', async (c) => {
  const input = await c.req.json<OnCommentSubmitRequest>();
  const comment = input.comment;
  const author = input.author;
  if (!comment?.id) return c.json<TriggerResponse>({ status: 'success' }, 200);

  await handleSubmit({
    type: 'comment',
    thingId: comment.id,
    body: comment.body ?? '',
    authorId: author?.id,
    authorName: author?.name,
    permalink: comment.permalink,
    createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : undefined,
  });

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-update', async (c) => {
  const input = await c.req.json<OnPostUpdateRequest>();
  const post = input.post;
  const author = input.author;
  if (!post?.id) return c.json<TriggerResponse>({ status: 'success' }, 200);

  await handleUpdate({
    type: 'post',
    thingId: post.id,
    body: combinePostBody(post),
    authorId: author?.id,
    authorName: author?.name,
    permalink: post.permalink,
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : undefined,
  });

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-comment-update', async (c) => {
  const input = await c.req.json<OnCommentUpdateRequest>();
  const comment = input.comment;
  const author = input.author;
  if (!comment?.id) return c.json<TriggerResponse>({ status: 'success' }, 200);

  await handleUpdate({
    type: 'comment',
    thingId: comment.id,
    body: comment.body ?? '',
    authorId: author?.id,
    authorName: author?.name,
    permalink: comment.permalink,
    createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : undefined,
  });

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-delete', async (c) => {
  const input = await c.req.json<OnPostDeleteRequest>();
  if (input.postId) await handleDelete(input.postId);
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-comment-delete', async (c) => {
  const input = await c.req.json<OnCommentDeleteRequest>();
  if (input.commentId) await handleDelete(input.commentId);
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

function combinePostBody(post: {
  title?: string | undefined;
  body?: string | undefined;
  url?: string | undefined;
}): string {
  const parts: string[] = [];
  if (post.title) parts.push(post.title);
  if (post.body) parts.push(post.body);
  if (post.url) parts.push(post.url);
  return parts.join('\n');
}
