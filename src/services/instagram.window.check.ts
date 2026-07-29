import assert from 'node:assert/strict';
import { isInstagramOutsideMessagingWindow } from './instagram.js';

function asAxios(message: string, code = 10, error_subcode?: number) {
  return {
    isAxiosError: true,
    response: {
      data: { error: { message, code, error_subcode } },
      status: 400,
    },
  };
}

assert.equal(
  isInstagramOutsideMessagingWindow(
    asAxios('(#10) This message is being sent outside of allowed window.')
  ),
  true
);
assert.equal(
  isInstagramOutsideMessagingWindow(
    asAxios(
      '(#10) This message is being sent outside the allowed window. Learn more about the new policy'
    )
  ),
  true
);
assert.equal(isInstagramOutsideMessagingWindow(asAxios('permission denied', 10)), false);
assert.equal(isInstagramOutsideMessagingWindow(asAxios('x', 10, 2534022)), true);

console.log('instagram.window.check: ok');
