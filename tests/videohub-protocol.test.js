import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    splitBlocks,
    parseBlock,
    buildRoutingCommand,
    buildLockCommand,
    buildInputLabelCommand,
    buildOutputLabelCommand,
} from '../videohub_protocol.js';

test('splitBlocks pulls complete blocks off the buffer and keeps the remainder', () => {
    const { blocks, remainder } = splitBlocks('VIDEO OUTPUT ROUTING:\n0 1\n1 0\n\nVIDEOHUB DEV');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].header, 'VIDEO OUTPUT ROUTING:');
    assert.deepEqual(blocks[0].lines, ['0 1', '1 0']);
    assert.equal(remainder, 'VIDEOHUB DEV');
});

test('splitBlocks tolerates CRLF line endings, not just the spec\'s bare LF', () => {
    const { blocks, remainder } = splitBlocks('VIDEO OUTPUT ROUTING:\r\n0 1\r\n1 0\r\n\r\nVIDEOHUB DEV');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].header, 'VIDEO OUTPUT ROUTING:');
    assert.deepEqual(blocks[0].lines, ['0 1', '1 0']);
    assert.equal(remainder, 'VIDEOHUB DEV');
});

test('splitBlocks handles several blocks arriving in one chunk', () => {
    const { blocks, remainder } = splitBlocks('ACK\n\nVIDEO OUTPUT ROUTING:\n0 1\n\n');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].header, 'ACK');
    assert.equal(blocks[1].header, 'VIDEO OUTPUT ROUTING:');
    assert.equal(remainder, '');
});

test('parseBlock reads device capabilities', () => {
    const { type, patch } = parseBlock({
        header: 'VIDEOHUB DEVICE:',
        lines: ['Device present: true', 'Model name: Blackmagic Smart Videohub 40 x 40', 'Video inputs: 40', 'Video outputs: 40'],
    });
    assert.equal(type, 'device');
    assert.equal(patch.modelName, 'Blackmagic Smart Videohub 40 x 40');
    assert.equal(patch.videoInputs, 40);
    assert.equal(patch.videoOutputs, 40);
});

test('parseBlock reads indexed labels', () => {
    const { type, patch } = parseBlock({ header: 'INPUT LABELS:', lines: ['0 Camera 1', '1 Camera 2'] });
    assert.equal(type, 'inputLabels');
    assert.deepEqual(patch, [{ index: 0, label: 'Camera 1' }, { index: 1, label: 'Camera 2' }]);
});

test('parseBlock reads routing as numeric source indexes', () => {
    const { type, patch } = parseBlock({ header: 'VIDEO OUTPUT ROUTING:', lines: ['0 3', '1 0'] });
    assert.equal(type, 'routing');
    assert.deepEqual(patch, [{ index: 0, source: 3 }, { index: 1, source: 0 }]);
});

test('parseBlock reads locks — both O (owned) and F (forced) mean locked', () => {
    const { type, patch } = parseBlock({ header: 'VIDEO OUTPUT LOCKS:', lines: ['0 O', '1 F', '2 U'] });
    assert.equal(type, 'locks');
    assert.deepEqual(patch, [
        { index: 0, locked: true },
        { index: 1, locked: true },
        { index: 2, locked: false },
    ]);
});

test('parseBlock recognizes END PRELUDE (real firmware), END PREAMBLE, ACK and NAK with no body', () => {
    // Confirmed against a real Blackmagic Smart Videohub 20 x 20: it closes
    // the initial dump with "END PRELUDE:", not "END PREAMBLE:" — despite the
    // opening block being "PROTOCOL PREAMBLE:". Both are accepted.
    assert.equal(parseBlock({ header: 'END PRELUDE:', lines: [] }).type, 'end');
    assert.equal(parseBlock({ header: 'END PREAMBLE:', lines: [] }).type, 'end');
    assert.equal(parseBlock({ header: 'ACK', lines: [] }).type, 'ack');
    assert.equal(parseBlock({ header: 'NAK', lines: [] }).type, 'nak');
});

test('parseBlock treats an unrecognized header as unknown, not an error', () => {
    const { type, patch } = parseBlock({ header: 'SERIAL PORT LABELS:', lines: ['0 RS422'] });
    assert.equal(type, 'unknown');
    assert.equal(patch, null);
});

test('command builders produce protocol-shaped, blank-line-terminated blocks', () => {
    assert.equal(buildRoutingCommand([{ destIndex: 0, srcIndex: 3 }]), 'VIDEO OUTPUT ROUTING:\n0 3\n\n');
    assert.equal(
        buildRoutingCommand([{ destIndex: 0, srcIndex: 3 }, { destIndex: 1, srcIndex: 0 }]),
        'VIDEO OUTPUT ROUTING:\n0 3\n1 0\n\n',
        'a multi-destination TAKE must be one block, not one message per destination'
    );
    assert.equal(buildLockCommand(2, true), 'VIDEO OUTPUT LOCKS:\n2 O\n\n');
    assert.equal(buildLockCommand(2, false), 'VIDEO OUTPUT LOCKS:\n2 U\n\n');
    assert.equal(buildInputLabelCommand(0, 'Podium Cam'), 'INPUT LABELS:\n0 Podium Cam\n\n');
    assert.equal(buildOutputLabelCommand(0, 'Program'), 'OUTPUT LABELS:\n0 Program\n\n');
});
