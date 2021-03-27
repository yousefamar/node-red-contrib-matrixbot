// Utility functions for parsing and decrypting megolm keys
// Based on: https://github.com/matrix-org/matrix-react-sdk/blob/develop/src/utils/MegolmExportEncryption.js

const subtleCrypto = require('subtle-crypto')
// NOTE: subtleCrypto is a web API that was added to node in 15.0.0
// At the time of writing, node LTS is 14.15.4, so I'm using this lib
// for wider support. When LTS is >=15.0.0, we should use:
// https://nodejs.org/api/webcrypto.html#webcrypto_class_subtlecrypto

const HEADER_LINE = '-----BEGIN MEGOLM SESSION DATA-----';
const TRAILER_LINE = '-----END MEGOLM SESSION DATA-----';

/**
 * Unbase64 an ascii-armoured megolm key file
 *
 * Strips the header and trailer lines, and unbase64s the content
 *
 * @param {ArrayBuffer} data  input file
 * @return {Uint8Array} unbase64ed content
 */
function unpackMegolmKeyFile(data) {
	const fileStr = data;

	// look for the start line
	let lineStart = 0;
	while (1) {
		const lineEnd = fileStr.indexOf('\n', lineStart);
		if (lineEnd < 0) {
			throw new Error('Header line not found');
		}
		const line = fileStr.slice(lineStart, lineEnd).trim();

		// start the next line after the newline
		lineStart = lineEnd+1;

		if (line === HEADER_LINE) {
			break;
		}
	}

	const dataStart = lineStart;

	// look for the end line
	while (1) {
		const lineEnd = fileStr.indexOf('\n', lineStart);
		const line = fileStr.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
			.trim();
		if (line === TRAILER_LINE) {
			break;
		}

		if (lineEnd < 0) {
			throw new Error('Trailer line not found');
		}

		// start the next line after the newline
		lineStart = lineEnd+1;
	}

	const dataEnd = lineStart;

	return new Buffer(fileStr.slice(dataStart, dataEnd), 'base64').toString('ascii');
}

/**
 * Decrypt a megolm key file
 *
 * @param {ArrayBuffer} data file to decrypt
 * @param {String} password
 * @return {Promise<String>} promise for decrypted output
 */
async function decryptMegolmKeyFile(data, password) {
	const body = unpackMegolmKeyFile(data);

	// check we have a version byte
	if (body.length < 1) {
		throw friendlyError('Invalid file: too short',
			_t('Not a valid %(brand)s keyfile', { brand }));
	}

	const version = body[0];
	if (version !== 1) {
		throw friendlyError('Unsupported version',
			_t('Not a valid %(brand)s keyfile', { brand }));
	}

	const ciphertextLength = body.length-(1+16+16+4+32);
	if (ciphertextLength < 0) {
		throw friendlyError('Invalid file: too short',
			_t('Not a valid %(brand)s keyfile', { brand }));
	}

	const salt = body.subarray(1, 1+16);
	const iv = body.subarray(17, 17+16);
	const iterations = body[33] << 24 | body[34] << 16 | body[35] << 8 | body[36];
	const ciphertext = body.subarray(37, 37+ciphertextLength);
	const hmac = body.subarray(-32);

	const [aesKey, hmacKey] = await deriveKeys(salt, iterations, password);
	const toVerify = body.subarray(0, -32);

	let isValid;
	try {
		isValid = await subtleCrypto.verify(
			{name: 'HMAC'},
			hmacKey,
			hmac,
			toVerify,
		);
	} catch (e) {
		throw friendlyError('subtleCrypto.verify failed: ' + e, cryptoFailMsg());
	}
	if (!isValid) {
		throw friendlyError('hmac mismatch',
			_t('Authentication check failed: incorrect password?'));
	}

	let plaintext;
	try {
		plaintext = await subtleCrypto.decrypt(
			{
				name: "AES-CTR",
				counter: iv,
				length: 64,
			},
			aesKey,
			ciphertext,
		);
	} catch (e) {
		throw friendlyError('subtleCrypto.decrypt failed: ' + e, cryptoFailMsg());
	}

	return new TextDecoder().decode(new Uint8Array(plaintext));
}

module.exports = {
	decryptMegolmKeyFile
};
