import { shapeListeningMediaItem, shapeListeningComment } from './instagramListening.service.js';

const reel = shapeListeningMediaItem({
  id: '1',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  media_url: 'https://example.com/v.mp4',
  thumbnail_url: 'https://example.com/t.jpg',
  caption: 'hello',
  like_count: 3,
  comments_count: 1,
  permalink: 'https://instagram.com/p/1',
  timestamp: '2026-01-01T00:00:00+0000',
});

const post = shapeListeningMediaItem({
  id: '2',
  media_type: 'IMAGE',
  media_product_type: 'FEED',
  media_url: 'https://example.com/i.jpg',
});

const comment = shapeListeningComment({
  id: 'c1',
  text: 'Nice!',
  username: 'buyer',
  like_count: 2,
  replies: {
    data: [{ id: 'c2', text: 'Thanks', username: 'brand', like_count: 0 }],
  },
});

console.assert(reel.isReel === true, 'REELS product type → isReel');
console.assert(post.isReel === false, 'FEED image → not reel');
console.assert(post.thumbnailUrl === 'https://example.com/i.jpg', 'falls back to media_url');
console.assert(reel.likeCount === 3 && reel.commentsCount === 1);
console.assert(comment.replies.length === 1 && comment.replies[0].text === 'Thanks');

console.log('instagramListening.service.check: ok');
