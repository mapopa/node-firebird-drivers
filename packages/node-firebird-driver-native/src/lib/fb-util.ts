import { ClientImpl } from './client';

import * as fb from 'node-firebird-native-api';

import * as os from 'os';
const littleEndian = os.endianness() === 'LE';

import * as stringDecoder from 'string_decoder';


/** SQL_* type constants */
export namespace sqlTypes {
	export const SQL_TEXT = 452;
	export const SQL_VARYING = 448;
	export const SQL_SHORT = 500;
	export const SQL_LONG = 496;
	export const SQL_FLOAT = 482;
	export const SQL_DOUBLE = 480;
	//export const SQL_D_FLOAT = 530;
	export const SQL_TIMESTAMP = 510;
	//// TODO: export const SQL_BLOB = 520;
	//export const SQL_ARRAY = 540;
	//export const SQL_QUAD = 550;
	export const SQL_TYPE_TIME = 560;
	export const SQL_TYPE_DATE = 570;
	export const SQL_INT64 = 580;
	export const SQL_BOOLEAN = 32764;
	export const SQL_NULL = 32766;
}

/** DPB constants. */
export namespace dpb {
	export const lc_ctype = 48;
	export const user_name = 28;
	export const password = 29;
}

/** Changes a number from a scale to another. */
/***
export function changeScale(value: number, inputScale: number, outputScale: number): number {
	outputScale -= inputScale;

	Math.pow(10, outputScale);

	if (outputScale === 0)
		return value;
	else if (outputScale > 0)
		return value / Math.pow(10, outputScale);
	else	// outputScale < 0
		return value * Math.pow(10, -outputScale);
}
***/

/** Fix metadata descriptors to types we want to read. */
export function fixMetadata(status: fb.Status, metadata: fb.MessageMetadata): fb.MessageMetadata {
	let ret: fb.MessageMetadata;

	const outBuilder = metadata.getBuilderSync(status);
	try {
		for (let i = metadata.getCountSync(status) - 1; i >= 0; --i) {
			switch (metadata.getTypeSync(status, i)) {
				// Transforms CHAR descriptors to VARCHAR.
				case sqlTypes.SQL_TEXT:
					outBuilder.setTypeSync(status, i, sqlTypes.SQL_VARYING);
					break;

				// Transforms numeric descriptors to DOUBLE PRECISION.
				case sqlTypes.SQL_SHORT:
				case sqlTypes.SQL_LONG:
				case sqlTypes.SQL_INT64:
				case sqlTypes.SQL_FLOAT:
					outBuilder.setTypeSync(status, i, sqlTypes.SQL_DOUBLE);
					outBuilder.setLengthSync(status, i, 8);
					outBuilder.setScaleSync(status, i, 0);
					break;
			}
		}

		ret = outBuilder.getMetadataSync(status);
	}
	finally {
		outBuilder.releaseSync();
	}

	metadata.releaseSync();

	return ret;
}

/** Creates a data reader. */
export function createDataReader(status: fb.Status, client: ClientImpl, metadata: fb.MessageMetadata): (buffer: Uint8Array) => any[] {
	const count = metadata.getCountSync(status);
	const mappers = new Array<(buffer: Uint8Array) => any>(count);

	for (let i = 0; i < count; ++i) {
		const nullOffset = metadata.getNullOffsetSync(status, i);
		const type = metadata.getTypeSync(status, i);
		const offset = metadata.getOffsetSync(status, i);
		///const length = metadata.getLengthSync(status, i);
		///const scale = metadata.getScaleSync(status, i);

		mappers[i] = (buffer: Uint8Array): any => {
			const dataView = new DataView(buffer.buffer);

			if (dataView.getInt16(nullOffset, littleEndian) == -1)
				return null;

			switch (type) {
				// SQL_TEXT is handled changing its descriptor to SQL_VARYING with IMetadataBuilder.
				case sqlTypes.SQL_VARYING: {
					//// TODO: none, octets
					const varLength = dataView.getUint16(offset, littleEndian);
					const decoder = new stringDecoder.StringDecoder('utf8');
					const buf = Buffer.from(buffer.buffer, offset + 2, varLength);
					return decoder.end(buf);
				}

				/***
				case sqlTypes.SQL_SHORT:
					return changeScale(dataView.getInt16(offset, littleEndian), scale, 0);

				case sqlTypes.SQL_LONG:
					return changeScale(dataView.getInt32(offset, littleEndian), scale, 0);

				//// TODO: sqlTypes.SQL_INT64

				case sqlTypes.SQL_FLOAT:
					return dataView.getFloat32(offset, littleEndian);
				***/

				case sqlTypes.SQL_DOUBLE:
					return dataView.getFloat64(offset, littleEndian);

				case sqlTypes.SQL_TYPE_TIME: {
					const now = new Date();
					const hours = new Uint32Array(1);
					const minutes = new Uint32Array(1);
					const seconds = new Uint32Array(1);
					const fractions = new Uint32Array(1);
					client.util.decodeTimeSync(dataView.getUint32(offset, littleEndian), hours, minutes, seconds, fractions);
					return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours[0], minutes[0], seconds[0], fractions[0] / 10);
				}

				case sqlTypes.SQL_TYPE_DATE: {
					const year = new Uint32Array(1);
					const month = new Uint32Array(1);
					const day = new Uint32Array(1);
					client.util.decodeDateSync(dataView.getInt32(offset, littleEndian), year, month, day);
					return new Date(year[0], month[0] - 1, day[0]);
				}

				case sqlTypes.SQL_TIMESTAMP: {
					const year = new Uint32Array(1);
					const month = new Uint32Array(1);
					const day = new Uint32Array(1);
					const hours = new Uint32Array(1);
					const minutes = new Uint32Array(1);
					const seconds = new Uint32Array(1);
					const fractions = new Uint32Array(1);
					client.util.decodeDateSync(dataView.getInt32(offset, littleEndian), year, month, day);
					client.util.decodeTimeSync(dataView.getUint32(offset + 4, littleEndian), hours, minutes, seconds, fractions);
					return new Date(year[0], month[0] - 1, day[0], hours[0], minutes[0], seconds[0], fractions[0] / 10);
				}

				case sqlTypes.SQL_BOOLEAN:
					return dataView.getInt8(offset) != 0;

				case sqlTypes.SQL_NULL:
					return null;

				default:
					throw new Error(`Unrecognized Firebird type number ${type}`);
			}
		}
	}

	return (buffer: Uint8Array): any[] => {
		const ret = new Array(count);

		for (let i = 0; i < count; ++i)
			ret[i] = mappers[i](buffer);

		return ret;
	}
}

/** Creates a data writer. */
export function createDataWriter(status: fb.Status, client: ClientImpl, metadata: fb.MessageMetadata):
		(buffer: Uint8Array, values: Array<any>) => void {
	const count = metadata.getCountSync(status);
	const mappers = new Array<(buffer: Uint8Array, value: any) => void>(count);

	for (let i = 0; i < count; ++i) {
		const nullOffset = metadata.getNullOffsetSync(status, i);
		const type = metadata.getTypeSync(status, i);
		const offset = metadata.getOffsetSync(status, i);
		const length = metadata.getLengthSync(status, i);
		///const scale = metadata.getScaleSync(status, i);

		mappers[i] = (buffer: Uint8Array, value: any): void => {
			const dataView = new DataView(buffer.buffer);

			if (value == null) {
				dataView.setInt16(nullOffset, -1, littleEndian);
				return;
			}

			switch (type) {
				// SQL_TEXT is handled changing its descriptor to SQL_VARYING with IMetadataBuilder.
				case sqlTypes.SQL_VARYING: {
					//// TODO: none, octets
					const str = value as string;
					const strBuffer = Buffer.from(str);

					const bytesArray = Uint8Array.from(strBuffer);

					if (bytesArray.length > length) {
						throw new Error(`Length in bytes of string '${str}' (${bytesArray.length}) is ` +
							`greater than maximum expect length ${length}.`);
					}

					dataView.setUint16(offset, bytesArray.length, littleEndian);

					for (let i = 0; i < bytesArray.length; ++i)
						buffer[offset + 2 + i] = bytesArray[i];

					break;
				}

				/***
				case sqlTypes.SQL_SHORT:
					dataView.setInt16(offset, changeScale(value, 0, scale), littleEndian);
					break;

				case sqlTypes.SQL_LONG:
					dataView.setInt32(offset, changeScale(value, 0, scale), littleEndian);
					break;

				//// TODO: sqlTypes.SQL_INT64

				case sqlTypes.SQL_FLOAT:
					dataView.setFloat32(offset, value, littleEndian);
					break;
				***/

				case sqlTypes.SQL_DOUBLE:
					dataView.setFloat64(offset, value, littleEndian);
					break;

				case sqlTypes.SQL_TYPE_TIME: {
					const date = value as Date;
					dataView.setUint32(offset,
						client.util.encodeTimeSync(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds() * 10),
						littleEndian);
					break;
				}

				case sqlTypes.SQL_TYPE_DATE: {
					const date = value as Date;
					dataView.setInt32(offset,
						client.util.encodeDateSync(date.getFullYear(), date.getMonth() + 1, date.getDate()),
						littleEndian);
					break;
				}

				case sqlTypes.SQL_TIMESTAMP: {
					const date = value as Date;
					dataView.setInt32(offset,
						client.util.encodeDateSync(date.getFullYear(), date.getMonth() + 1, date.getDate()),
						littleEndian);
					dataView.setUint32(offset + 4,
						client.util.encodeTimeSync(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds() * 10),
						littleEndian);
					break;
				}

				case sqlTypes.SQL_BOOLEAN:
					dataView.setInt8(offset, value ? 1 : 0);
					break;

				case sqlTypes.SQL_NULL:
					break;

				default:
					throw new Error(`Unrecognized Firebird type number ${type}`);
			}
		}
	}

	return (buffer: Uint8Array, values: Array<any>): void => {
		if ((values || []).length !== count)
			throw new Error(`Incorrect number of parameters: expected ${count}, received ${(values || []).length}.`);

		for (let i = 0; i < count; ++i)
			mappers[i](buffer, values[i]);
	}
}
