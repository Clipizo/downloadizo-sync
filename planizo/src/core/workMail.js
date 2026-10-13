import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "#imapflow";
import { protect, unprotect } from "./secretBox.js";
import { ValueError, casefold, truthy } from "../py.js";

export const IMAP_HOST = "imap.hostinger.com";
export const IMAP_PORT = 993;
export const MESSAGE_LIMIT = 30;
export const MESSAGE_BYTES = 32768;

export class LookupError extends Error {}
export class UnicodeDecodeError extends ValueError {}
class HeaderParseError extends Error {}
class IndexError extends Error {}
class InvalidEwError extends HeaderParseError {}

const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_BOTH = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const STRIP_LEFT = new RegExp(`^[${WS}]+`);
const STRIP_RIGHT = new RegExp(`[${WS}]+$`);
const SPLIT_WS = new RegExp(`[${WS}]+`);
const strip = (s) => s.replace(STRIP_BOTH, "");
const lstrip = (s) => s.replace(STRIP_LEFT, "");
const rstrip = (s) => s.replace(STRIP_RIGHT, "");
const pySplit = (s) => s.split(SPLIT_WS).filter(Boolean);

function splitMax(s, sep, maxsplit) {
  const out = [];
  let rest = s;
  while (out.length < maxsplit) {
    const at = rest.indexOf(sep);
    if (at < 0) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  out.push(rest);
  return out;
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function pyInt(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValueError(`cannot convert float ${value} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = strip(String(value));
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) throw new ValueError(`invalid literal for int() with base 10: '${value}'`);
  return Number(text.replace(/_/g, "")) + 0;
}

function pyRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return quote + out + quote;
}

function writeJsonAscii(value) {
  return JSON.stringify(value, null, 2).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export class WorkMailConfig {
  constructor(filePath) {
    this.path = String(filePath);
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const pending = this.path + ".tmp";
    fs.writeFileSync(pending, writeJsonAscii(data), "utf-8");
    fs.renameSync(pending, this.path);
  }

  accountEmail() {
    const data = this.read();
    return truthy(data.email) ? pyStr(data.email) : "";
  }

  credentials() {
    const data = this.read();
    const emailAddress = strip(truthy(data.email) ? pyStr(data.email) : "");
    const encrypted = truthy(data.password) ? pyStr(data.password) : "";
    if (!emailAddress || !encrypted) return null;
    return {
      email: emailAddress,
      password: unprotect(encrypted),
      host: IMAP_HOST,
      port: IMAP_PORT,
      last_seen_uid: pyInt(truthy(data.last_seen_uid) ? data.last_seen_uid : 0),
    };
  }

  saveAccount(emailAddress, password) {
    const existing = this.read();
    const previousEmail = casefold(truthy(existing.email) ? pyStr(existing.email) : "");
    const sameAccount = previousEmail === casefold(emailAddress);
    let encrypted;
    if (password) encrypted = protect(password);
    else if (sameAccount && truthy(existing.password)) encrypted = pyStr(existing.password);
    else throw new ValueError("Enter your mailbox password.");
    this.write({
      version: 1,
      email: emailAddress,
      password: encrypted,
      last_seen_uid: sameAccount ? pyInt(truthy(existing.last_seen_uid) ? existing.last_seen_uid : 0) : 0,
    });
  }

  updateLastSeen(uid) {
    const data = this.read();
    if (truthy(data) && uid > pyInt(truthy(data.last_seen_uid) ? data.last_seen_uid : 0)) {
      data.last_seen_uid = uid;
      this.write(data);
    }
  }

  clear() {
    try {
      fs.rmSync(this.path, { force: true });
    } catch {}
  }
}

const CODEC_ALIASES = {
  ascii: "646 ansi_x3.4_1968 ansi_x3.4_1986 ansi_x3_4_1968 cp367 csascii ibm367 iso646_us iso_646.irv_1991 iso_ir_6 us us_ascii",
  big5: "big5_tw csbig5 x_mac_trad_chinese",
  big5hkscs: "big5_hkscs hkscs",
  cp1250: "1250 windows_1250",
  cp1251: "1251 windows_1251",
  cp1252: "1252 windows_1252",
  cp1253: "1253 windows_1253",
  cp1254: "1254 windows_1254",
  cp1255: "1255 windows_1255",
  cp1256: "1256 windows_1256",
  cp1257: "1257 windows_1257",
  cp1258: "1258 windows_1258",
  cp437: "437 cspc8codepage437 ibm437",
  cp850: "850 cspc850multilingual ibm850",
  cp866: "866 csibm866 ibm866",
  cp932: "932 ms932 ms_kanji mskanji",
  cp949: "949 ms949 uhc",
  euc_jp: "eucjp u_jis ujis",
  euc_kr: "euckr korean ks_c_5601 ks_c_5601_1987 ks_x_1001 ksc5601 ksx1001 x_mac_korean",
  gb18030: "gb18030_2000",
  gb2312: "chinese csiso58gb231280 euc_cn euccn eucgb2312_cn gb2312_1980 gb2312_80 iso_ir_58 x_mac_simp_chinese",
  gbk: "936 cp936 ms936",
  iso2022_jp: "csiso2022jp iso2022jp iso_2022_jp",
  iso8859_10: "csisolatin6 iso_8859_10 iso_8859_10_1992 iso_ir_157 l6 latin6",
  iso8859_11: "iso_8859_11 iso_8859_11_2001 thai",
  iso8859_13: "iso_8859_13 l7 latin7",
  iso8859_14: "iso_8859_14 iso_8859_14_1998 iso_celtic iso_ir_199 l8 latin8",
  iso8859_15: "iso_8859_15 l9 latin9",
  iso8859_16: "iso_8859_16 iso_8859_16_2001 iso_ir_226 l10 latin10",
  iso8859_2: "csisolatin2 iso_8859_2 iso_8859_2_1987 iso_ir_101 l2 latin2",
  iso8859_3: "csisolatin3 iso_8859_3 iso_8859_3_1988 iso_ir_109 l3 latin3",
  iso8859_4: "csisolatin4 iso_8859_4 iso_8859_4_1988 iso_ir_110 l4 latin4",
  iso8859_5: "csisolatincyrillic cyrillic iso_8859_5 iso_8859_5_1988 iso_ir_144",
  iso8859_6: "arabic asmo_708 csisolatinarabic ecma_114 iso_8859_6 iso_8859_6_1987 iso_ir_127",
  iso8859_7: "csisolatingreek ecma_118 elot_928 greek greek8 iso_8859_7 iso_8859_7_1987 iso_ir_126",
  iso8859_8: "csisolatinhebrew hebrew iso_8859_8 iso_8859_8_1988 iso_ir_138",
  iso8859_9: "csisolatin5 iso_8859_9 iso_8859_9_1989 iso_ir_148 l5 latin5",
  koi8_r: "cskoi8r",
  latin_1: "8859 cp819 csisolatin1 ibm819 iso8859 iso8859_1 iso_8859_1 iso_8859_1_1987 iso_ir_100 l1 latin latin1",
  mac_roman: "macintosh macroman",
  shift_jis: "csshiftjis s_jis shiftjis sjis x_mac_japanese",
  tis_620: "iso_ir_166 tis620 tis_620_0 tis_620_2529_0 tis_620_2529_1",
  utf_16: "u16 utf16",
  utf_16_be: "unicodebigunmarked utf_16be",
  utf_16_le: "unicodelittleunmarked utf_16le",
  utf_7: "u7 unicode_1_1_utf_7 utf7",
  utf_8: "cp65001 u8 utf utf8 utf8_ucs2 utf8_ucs4",
};
const SINGLE_BYTE = {
  cp1250: "€\ufffd‚\ufffd„…†‡\ufffd‰Š‹ŚŤŽŹ\ufffd‘’“”•–—\ufffd™š›śťžź ˇ˘Ł¤Ą¦§¨©Ş«¬\u00ad®Ż°±˛ł´µ¶·¸ąş»Ľ˝ľżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙",
  cp1251: "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\ufffd™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя",
  cp1252: "€\ufffd‚ƒ„…†‡ˆ‰Š‹Œ\ufffdŽ\ufffd\ufffd‘’“”•–—˜™š›œ\ufffdžŸ ¡¢£¤¥¦§¨©ª«¬\u00ad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
  cp1253: "€\ufffd‚ƒ„…†‡\ufffd‰\ufffd‹\ufffd\ufffd\ufffd\ufffd\ufffd‘’“”•–—\ufffd™\ufffd›\ufffd\ufffd\ufffd\ufffd ΅Ά£¤¥¦§¨©\ufffd«¬\u00ad®―°±²³΄µ¶·ΈΉΊ»Ό½ΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ\ufffdΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ\ufffd",
  cp1254: "€\ufffd‚ƒ„…†‡ˆ‰Š‹Œ\ufffd\ufffd\ufffd\ufffd‘’“”•–—˜™š›œ\ufffd\ufffdŸ ¡¢£¤¥¦§¨©ª«¬\u00ad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏĞÑÒÓÔÕÖ×ØÙÚÛÜİŞßàáâãäåæçèéêëìíîïğñòóôõö÷øùúûüışÿ",
  cp1255: "€\ufffd‚ƒ„…†‡ˆ‰\ufffd‹\ufffd\ufffd\ufffd\ufffd\ufffd‘’“”•–—˜™\ufffd›\ufffd\ufffd\ufffd\ufffd ¡¢£₪¥¦§¨©×«¬\u00ad®¯°±²³´µ¶·¸¹÷»¼½¾¿ְֱֲֳִֵֶַָֹ\ufffdֻּֽ־ֿ׀ׁׂ׃װױײ׳״\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffdאבגדהוזחטיךכלםמןנסעףפץצקרשת\ufffd\ufffd‎‏\ufffd",
  cp1256: "€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈگ‘’“”•–—ک™ڑ›œ‌‍ں ،¢£¤¥¦§¨©ھ«¬\u00ad®¯°±²³´µ¶·¸¹؛»¼½¾؟ہءآأؤإئابةتثجحخدذرزسشصض×طظعغـفقكàلâمنهوçèéêëىيîïًٌٍَôُِ÷ّùْûü‎‏ے",
  cp1257: "€\ufffd‚\ufffd„…†‡\ufffd‰\ufffd‹\ufffd¨ˇ¸\ufffd‘’“”•–—\ufffd™\ufffd›\ufffd¯˛\ufffd \ufffd¢£¤\ufffd¦§Ø©Ŗ«¬\u00ad®Æ°±²³´µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž˙",
  cp1258: "€\ufffd‚ƒ„…†‡ˆ‰\ufffd‹Œ\ufffd\ufffd\ufffd\ufffd‘’“”•–—˜™\ufffd›œ\ufffd\ufffdŸ ¡¢£¤¥¦§¨©ª«¬\u00ad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂĂÄÅÆÇÈÉÊË̀ÍÎÏĐÑ̉ÓÔƠÖ×ØÙÚÛÜỮßàáâăäåæçèéêë́íîïđṇ̃óôơö÷øùúûüư₫ÿ",
  iso8859_2: "~ Ą˘Ł¤ĽŚ§¨ŠŞŤŹ\u00adŽŻ°ą˛ł´ľśˇ¸šşťź˝žżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙",
  iso8859_3: "~ Ħ˘£¤\ufffdĤ§¨İŞĞĴ\u00ad\ufffdŻ°ħ²³´µĥ·¸ışğĵ½\ufffdżÀÁÂ\ufffdÄĊĈÇÈÉÊËÌÍÎÏ\ufffdÑÒÓÔĠÖ×ĜÙÚÛÜŬŜßàáâ\ufffdäċĉçèéêëìíîï\ufffdñòóôġö÷ĝùúûüŭŝ˙",
  iso8859_4: "~ ĄĸŖ¤ĨĻ§¨ŠĒĢŦ\u00adŽ¯°ą˛ŗ´ĩļˇ¸šēģŧŊžŋĀÁÂÃÄÅÆĮČÉĘËĖÍÎĪĐŅŌĶÔÕÖ×ØŲÚÛÜŨŪßāáâãäåæįčéęëėíîīđņōķôõö÷øųúûüũū˙",
  iso8859_5: "~ ЁЂЃЄЅІЇЈЉЊЋЌ\u00adЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя№ёђѓєѕіїјљњћќ§ўџ",
  iso8859_6: "~ \ufffd\ufffd\ufffd¤\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd،\u00ad\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd؛\ufffd\ufffd\ufffd؟\ufffdءآأؤإئابةتثجحخدذرزسشصضطظعغ\ufffd\ufffd\ufffd\ufffd\ufffdـفقكلمنهوىيًٌٍَُِّْ\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd",
  iso8859_7: "~ ‘’£€₯¦§¨©ͺ«¬\u00ad\ufffd―°±²³΄΅Ά·ΈΉΊ»Ό½ΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ\ufffdΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ\ufffd",
  iso8859_8: "~ \ufffd¢£¤¥¦§¨©×«¬\u00ad®¯°±²³´µ¶·¸¹÷»¼½¾\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd‗אבגדהוזחטיךכלםמןנסעףפץצקרשת\ufffd\ufffd‎‏\ufffd",
  iso8859_9: "~ ¡¢£¤¥¦§¨©ª«¬\u00ad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏĞÑÒÓÔÕÖ×ØÙÚÛÜİŞßàáâãäåæçèéêëìíîïğñòóôõö÷øùúûüışÿ",
  iso8859_10: "~ ĄĒĢĪĨĶ§ĻĐŠŦŽ\u00adŪŊ°ąēģīĩķ·ļđšŧž―ūŋĀÁÂÃÄÅÆĮČÉĘËĖÍÎÏÐŅŌÓÔÕÖŨØŲÚÛÜÝÞßāáâãäåæįčéęëėíîïðņōóôõöũøųúûüýþĸ",
  iso8859_11: "~ กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู\ufffd\ufffd\ufffd\ufffd฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛\ufffd\ufffd\ufffd\ufffd",
  iso8859_13: "~ ”¢£¤„¦§Ø©Ŗ«¬\u00ad®Æ°±²³“µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž’",
  iso8859_14: "~ Ḃḃ£ĊċḊ§Ẁ©ẂḋỲ\u00ad®ŸḞḟĠġṀṁ¶ṖẁṗẃṠỳẄẅṡÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏŴÑÒÓÔÕÖṪØÙÚÛÜÝŶßàáâãäåæçèéêëìíîïŵñòóôõöṫøùúûüýŷÿ",
  iso8859_15: "~ ¡¢£€¥Š§š©ª«¬\u00ad®¯°±²³Žµ¶·ž¹º»ŒœŸ¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
  iso8859_16: "~ ĄąŁ€„Š§š©Ș«Ź\u00adźŻ°±ČłŽ”¶·žčș»ŒœŸżÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚßàáâăäćæçèéêëìíîïđńòóôőöśűùúûüęțÿ",
  koi8_r: "─│┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⌠■∙√≈≤≥ ⌡°²·÷═║╒ё╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡Ё╢╣╤╥╦╧╨╩╪╫╬©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ",
  koi8_u: "─│┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⌠■∙√≈≤≥ ⌡°²·÷═║╒ёє╔ії╗╘╙╚╛ґ╝╞╟╠╡ЁЄ╣ІЇ╦╧╨╩╪Ґ╬©юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ",
  cp874: "€\ufffd\ufffd\ufffd\ufffd…\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd‘’“”•–—\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู\ufffd\ufffd\ufffd\ufffd฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛\ufffd\ufffd\ufffd\ufffd",
  tis_620: "~\ufffdกขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู\ufffd\ufffd\ufffd\ufffd฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛\ufffd\ufffd\ufffd\ufffd",
  mac_roman: "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ",
  cp866: "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ",
  cp437: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  cp850: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■ ",
};
const MULTI_BYTE = {"utf_16": "utf-16le", "utf_16_le": "utf-16le", "utf_16_be": "utf-16be", "gb2312": "gbk", "gbk": "gbk", "gb18030": "gb18030", "big5": "big5", "big5hkscs": "big5", "shift_jis": "shift_jis", "cp932": "shift_jis", "euc_jp": "euc-jp", "iso2022_jp": "iso-2022-jp", "euc_kr": "euc-kr", "cp949": "euc-kr"};
const ENTITY_LIST = "AElig:c6,AMP:26,Aacute:c1,Acirc:c2,Agrave:c0,Alpha:391,Aring:c5,Atilde:c3,Auml:c4,Beta:392,COPY:a9,Ccedil:c7,Chi:3a7,Dagger:2021,Delta:394,ETH:d0,Eacute:c9,Ecirc:ca,Egrave:c8,Epsilon:395,Eta:397,Euml:cb,GT:3e,Gamma:393,Hat:5e,Iacute:cd,Icirc:ce,Igrave:cc,Iota:399,Iuml:cf,Kappa:39a,LT:3c,Lambda:39b,MediumSpace:205f,Mu:39c,NewLine:a,NoBreak:2060,Ntilde:d1,Nu:39d,OElig:152,Oacute:d3,Ocirc:d4,Ograve:d2,Omega:3a9,Omicron:39f,Oslash:d8,Otilde:d5,Ouml:d6,Phi:3a6,Pi:3a0,Prime:2033,Psi:3a8,QUOT:22,REG:ae,Rho:3a1,Scaron:160,Sigma:3a3,THORN:de,TRADE:2122,Tab:9,Tau:3a4,Theta:398,ThinSpace:2009,Uacute:da,Ucirc:db,Ugrave:d9,Upsilon:3a5,Uuml:dc,VeryThinSpace:200a,Xi:39e,Yacute:dd,Yuml:178,ZeroWidthSpace:200b,Zeta:396,aacute:e1,acirc:e2,acute:b4,aelig:e6,agrave:e0,alefsym:2135,alpha:3b1,amp:26,and:2227,ang:2220,apos:27,aring:e5,ast:2a,asymp:2248,atilde:e3,auml:e4,bdquo:201e,beta:3b2,brvbar:a6,bsol:5c,bull:2022,cap:2229,ccedil:e7,cedil:b8,cent:a2,centerdot:b7,check:2713,checkmark:2713,chi:3c7,circ:2c6,clubs:2663,colon:3a,comma:2c,cong:2245,copy:a9,copysr:2117,crarr:21b5,cross:2717,cup:222a,curren:a4,dArr:21d3,dagger:2020,darr:2193,deg:b0,delta:3b4,diams:2666,divide:f7,dollar:24,eacute:e9,ecirc:ea,egrave:e8,empty:2205,emsp:2003,ensp:2002,epsilon:3b5,equals:3d,equiv:2261,eta:3b7,eth:f0,euml:eb,euro:20ac,excl:21,exist:2203,fnof:192,forall:2200,frac12:bd,frac14:bc,frac34:be,frasl:2044,gamma:3b3,ge:2265,grave:60,gt:3e,hArr:21d4,hairsp:200a,half:bd,harr:2194,hearts:2665,hellip:2026,iacute:ed,icirc:ee,iexcl:a1,igrave:ec,image:2111,infin:221e,int:222b,iota:3b9,iquest:bf,isin:2208,iuml:ef,kappa:3ba,lArr:21d0,lambda:3bb,lang:27e8,laquo:ab,larr:2190,lceil:2308,lcub:7b,ldquo:201c,le:2264,lfloor:230a,lowast:2217,lowbar:5f,loz:25ca,lpar:28,lrm:200e,lsaquo:2039,lsqb:5b,lsquo:2018,lt:3c,macr:af,mdash:2014,micro:b5,midast:2a,middot:b7,minus:2212,mu:3bc,nabla:2207,nbsp:a0,ndash:2013,ne:2260,ni:220b,not:ac,notin:2209,nsub:2284,ntilde:f1,nu:3bd,num:23,oacute:f3,ocirc:f4,oelig:153,ograve:f2,oline:203e,omega:3c9,omicron:3bf,oplus:2295,or:2228,ordf:aa,ordm:ba,oslash:f8,otilde:f5,otimes:2297,ouml:f6,para:b6,part:2202,percnt:25,period:2e,permil:2030,perp:22a5,phi:3c6,phone:260e,pi:3c0,piv:3d6,plus:2b,plusmn:b1,pound:a3,prime:2032,prod:220f,prop:221d,psi:3c8,quest:3f,quot:22,rArr:21d2,radic:221a,rang:27e9,raquo:bb,rarr:2192,rceil:2309,rcub:7d,rdquo:201d,real:211c,reg:ae,rfloor:230b,rho:3c1,rlm:200f,rpar:29,rsaquo:203a,rsqb:5d,rsquo:2019,sbquo:201a,scaron:161,sdot:22c5,sect:a7,semi:3b,shy:ad,sigma:3c3,sigmaf:3c2,sim:223c,sol:2f,spades:2660,star:2606,starf:2605,sub:2282,sube:2286,sum:2211,sup:2283,sup1:b9,sup2:b2,sup3:b3,supe:2287,szlig:df,tau:3c4,there4:2234,theta:3b8,thetasym:3d1,thinsp:2009,thorn:fe,tilde:2dc,times:d7,trade:2122,uArr:21d1,uacute:fa,uarr:2191,ucirc:fb,ugrave:f9,uml:a8,upsih:3d2,upsilon:3c5,uuml:fc,verbar:7c,weierp:2118,xi:3be,yacute:fd,yen:a5,yuml:ff,zeta:3b6,zwj:200d,zwnj:200c";
const LEGACY_ENTITIES = "AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml";
const INVALID_CHARREFS = {0x0: 0xfffd, 0xd: 0xd, 0x80: 0x20ac, 0x81: 0x81, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8d: 0x8d, 0x8e: 0x17d, 0x8f: 0x8f, 0x90: 0x90, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9d: 0x9d, 0x9e: 0x17e, 0x9f: 0x178};
const INVALID_CODEPOINTS = [[0x1, 0x8], [0xb, 0xb], [0xe, 0x1f], [0x7f, 0x9f], [0xfdd0, 0xfdef], [0xfffe, 0xffff], [0x1fffe, 0x1ffff], [0x2fffe, 0x2ffff], [0x3fffe, 0x3ffff], [0x4fffe, 0x4ffff], [0x5fffe, 0x5ffff], [0x6fffe, 0x6ffff], [0x7fffe, 0x7ffff], [0x8fffe, 0x8ffff], [0x9fffe, 0x9ffff], [0xafffe, 0xaffff], [0xbfffe, 0xbffff], [0xcfffe, 0xcffff], [0xdfffe, 0xdffff], [0xefffe, 0xeffff], [0xffffe, 0xfffff], [0x10fffe, 0x10ffff]];

const ALIAS_TO_CODEC = new Map();
for (const [codec, names] of Object.entries(CODEC_ALIASES)) for (const name of names.split(" ")) ALIAS_TO_CODEC.set(name, codec);
const CODECS = new Set(["ascii", "latin_1", "utf_8", "utf_8_sig", "utf_7", ...Object.keys(SINGLE_BYTE), ...Object.keys(MULTI_BYTE)]);
const TABLE_CACHE = new Map();

function singleByteTable(codec) {
  if (!TABLE_CACHE.has(codec)) {
    const raw = SINGLE_BYTE[codec];
    let high = raw;
    if (raw.startsWith("~")) {
      high = "";
      for (let c = 0x80; c < 0xa0; c += 1) high += String.fromCharCode(c);
      high += raw.slice(1);
    }
    TABLE_CACHE.set(codec, Array.from(high));
  }
  return TABLE_CACHE.get(codec);
}

function normalizeEncoding(name) {
  let out = "";
  let punct = false;
  for (const c of String(name).toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(c) || c === ".") {
      if (punct && out) out += "_";
      if (c.charCodeAt(0) < 128) out += c;
      punct = false;
    } else {
      punct = true;
    }
  }
  return out;
}

function lookupCodec(name) {
  const norm = normalizeEncoding(name);
  const codec = ALIAS_TO_CODEC.get(norm) || ALIAS_TO_CODEC.get(norm.replace(/\./g, "_")) || (CODECS.has(norm) ? norm : null);
  if (!codec) throw new LookupError(`unknown encoding: ${name}`);
  return codec;
}

function badByte(b, errors, codec) {
  if (errors === "strict") throw new UnicodeDecodeError(`'${codec}' codec can't decode byte 0x${b.toString(16).padStart(2, "0")}`);
  return errors === "surrogateescape" ? String.fromCharCode(0xdc00 + b) : "�";
}

function textDecode(label, buf, errors, ignoreBOM = true) {
  let decoder;
  try {
    decoder = new TextDecoder(label, { fatal: errors === "strict", ignoreBOM });
  } catch {
    throw new LookupError(`unknown encoding: ${label}`);
  }
  try {
    return decoder.decode(buf);
  } catch {
    throw new UnicodeDecodeError(`'${label}' codec can't decode bytes`);
  }
}

function decodeBytes(buf, charset, errors = "strict") {
  if (Array.isArray(charset)) throw new TypeError("decode() argument 'encoding' must be str, not tuple");
  const codec = lookupCodec(charset);
  if (codec === "latin_1") return Buffer.from(buf).toString("latin1");
  if (codec === "ascii" || SINGLE_BYTE[codec]) {
    const table = codec === "ascii" ? null : singleByteTable(codec);
    const pieces = [];
    let run = [];
    const flush = () => {
      if (run.length) pieces.push(String.fromCharCode(...run));
      run = [];
    };
    for (const b of buf) {
      if (b < 0x80) {
        run.push(b);
        if (run.length > 4096) flush();
        continue;
      }
      flush();
      const ch = table ? table[b - 0x80] : "�";
      pieces.push(ch === "�" ? badByte(b, errors, codec) : ch);
    }
    flush();
    return pieces.join("");
  }
  if (codec === "utf_8" || codec === "utf_8_sig") {
    let body = Buffer.from(buf);
    if (codec === "utf_8_sig" && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
    return textDecode("utf-8", body, errors === "strict" ? "strict" : "replace");
  }
  if (codec === "utf_7") return decodeUtf7(Buffer.from(buf), errors);
  if (codec === "utf_16") {
    const body = Buffer.from(buf);
    if (body[0] === 0xfe && body[1] === 0xff) return textDecode("utf-16be", body.subarray(2), errors === "strict" ? "strict" : "replace");
    if (body[0] === 0xff && body[1] === 0xfe) return textDecode("utf-16le", body.subarray(2), errors === "strict" ? "strict" : "replace");
    return textDecode("utf-16le", body, errors === "strict" ? "strict" : "replace");
  }
  return textDecode(MULTI_BYTE[codec], Buffer.from(buf), errors === "strict" ? "strict" : "replace");
}

function decodeUtf7(buf, errors) {
  const out = [];
  const bad = () => {
    if (errors === "strict") throw new UnicodeDecodeError("'utf7' codec can't decode bytes");
    out.push("\ufffd");
  };
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const c = buf[i];
    if (c === 0x2b) {
      i += 1;
      if (i < n && buf[i] === 0x2d) {
        out.push("+");
        i += 1;
        continue;
      }
      if (i < n && B64_TABLE[buf[i]] < 0) {
        bad();
        i += 1;
        continue;
      }
      let bits = 0;
      let buffer = 0;
      const units = [];
      while (i < n && B64_TABLE[buf[i]] >= 0) {
        buffer = (buffer << 6) | B64_TABLE[buf[i]];
        bits += 6;
        if (bits >= 16) {
          bits -= 16;
          units.push((buffer >> bits) & 0xffff);
          buffer &= (1 << bits) - 1;
        }
        i += 1;
      }
      out.push(String.fromCharCode(...units));
      if (i >= n) {
        if (bits >= 6 || (bits > 0 && buffer !== 0)) bad();
        continue;
      }
      if (bits > 6 || (bits > 0 && buffer !== 0)) {
        bad();
        i += 1;
        continue;
      }
      if (buf[i] === 0x2d) i += 1;
      continue;
    }
    if (c < 0x80) out.push(String.fromCharCode(c));
    else bad();
    i += 1;
  }
  return out.join("");
}

function bytesToEscaped(buf) {
  const pieces = [];
  let run = [];
  for (const b of buf) {
    run.push(b < 0x80 ? b : 0xdc00 + b);
    if (run.length >= 4096) {
      pieces.push(String.fromCharCode(...run));
      run = [];
    }
  }
  if (run.length) pieces.push(String.fromCharCode(...run));
  return pieces.join("");
}

function escapedToBytes(s) {
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out[i] = c >= 0xdc80 && c <= 0xdcff ? c - 0xdc00 : c & 0xff;
  }
  return out;
}

const hasSurrogates = (s) => /[\ud800-\udfff]/.test(s);

function sanitize(s) {
  if (!hasSurrogates(s)) return s;
  const parts = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        parts.push(Buffer.from(s.slice(i, i + 2), "utf-8"));
        i += 1;
        continue;
      }
    }
    if (c >= 0xdc80 && c <= 0xdcff) parts.push(Buffer.from([c - 0xdc00]));
    else parts.push(Buffer.from(s[i], "utf-8"));
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(parts));
}

const B64_TABLE = new Int16Array(256).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => {
  B64_TABLE[c.charCodeAt(0)] = i;
});

function a2bBase64(buf) {
  const out = [];
  let quadPos = 0;
  let leftchar = 0;
  let pads = 0;
  for (const raw of buf) {
    if (raw === 0x3d) {
      pads += 1;
      if (quadPos >= 2 && quadPos + pads >= 4) return Buffer.from(out);
      continue;
    }
    const ch = B64_TABLE[raw];
    if (ch < 0) continue;
    pads = 0;
    if (quadPos === 0) {
      quadPos = 1;
      leftchar = ch;
    } else if (quadPos === 1) {
      quadPos = 2;
      out.push(((leftchar << 2) | (ch >> 4)) & 0xff);
      leftchar = ch & 0x0f;
    } else if (quadPos === 2) {
      quadPos = 3;
      out.push(((leftchar << 4) | (ch >> 2)) & 0xff);
      leftchar = ch & 0x03;
    } else {
      quadPos = 0;
      out.push(((leftchar << 6) | ch) & 0xff);
      leftchar = 0;
    }
  }
  if (quadPos !== 0) throw new ValueError(quadPos === 1 ? "Invalid base64-encoded string" : "Incorrect padding");
  return Buffer.from(out);
}

function decodeB(encoded) {
  const padErr = encoded.length % 4;
  const missing = padErr ? Buffer.from("===".slice(0, 4 - padErr)) : Buffer.alloc(0);
  const padded = Buffer.concat([encoded, missing]);
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(padded.toString("latin1"))) {
    try {
      return a2bBase64(padded);
    } catch {}
  }
  try {
    return a2bBase64(encoded);
  } catch {}
  try {
    return a2bBase64(Buffer.concat([encoded, Buffer.from("==")]));
  } catch {}
  return encoded;
}

function bytesSplitlinesJoin(buf) {
  const out = [];
  for (const b of buf) if (b !== 0x0a && b !== 0x0d) out.push(b);
  return Buffer.from(out);
}

const isHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

function a2bQp(data) {
  const out = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    if (data[i] === 0x3d) {
      i += 1;
      if (i >= n) break;
      if (data[i] === 0x0a || data[i] === 0x0d) {
        if (data[i] !== 0x0a) while (i < n && data[i] !== 0x0a) i += 1;
        if (i < n) i += 1;
      } else if (data[i] === 0x3d) {
        out.push(0x3d);
        i += 1;
      } else if (i + 1 < n && isHex(data[i]) && isHex(data[i + 1])) {
        out.push(parseInt(String.fromCharCode(data[i], data[i + 1]), 16));
        i += 2;
      } else {
        out.push(0x3d);
      }
    } else {
      out.push(data[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

const WSP = " \t";
const CFWS_LEADER = " \t(";
const SPECIALS = '()<>@,:;.\\"[]';
const ATOM_ENDS = SPECIALS + WSP;
const DOT_ATOM_ENDS = ATOM_ENDS.replace(".", "");
const PHRASE_ENDS = SPECIALS.replace(".", "").replace('"', "").replace("(", "");
const HEXDIGITS = "0123456789abcdefABCDEF";
const RFC2047 = /=\?[^?]*\?[qQbB]\?[^\n]*?\?=/;
const hasAny = (s, chars) => [...chars].some((c) => s.includes(c));

function term(s, type, kind = "v") {
  return { term: true, s, type, kind, toString: termStr };
}

function termStr() {
  return this.kind === "e" ? "" : this.s;
}

function tl(cls, items = [], type = null) {
  return { term: false, cls, type: type || TOKEN_TYPES[cls] || null, items };
}

const TOKEN_TYPES = {
  TokenList: null,
  Phrase: "phrase",
  CFWSList: "cfws",
  Atom: "atom",
  EncodedWord: "encoded-word",
  QuotedString: "quoted-string",
  BareQuotedString: "bare-quoted-string",
  Comment: "comment",
  AddressList: "address-list",
  Address: "address",
  MailboxList: "mailbox-list",
  GroupList: "group-list",
  Group: "group",
  NameAddr: "name-addr",
  AngleAddr: "angle-addr",
  ObsRoute: "obs-route",
  Mailbox: "mailbox",
  InvalidMailbox: "invalid-mailbox",
  Domain: "domain",
  DotAtom: "dot-atom",
  DotAtomText: "dot-atom-text",
  AddrSpec: "addr-spec",
  ObsLocalPart: "obs-local-part",
  DisplayName: "display-name",
  LocalPart: "local-part",
  DomainLiteral: "domain-literal",
};

const DOT = term(".", "dot");

function quoteString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function tokStr(tok) {
  if (tok.term) return tok.kind === "e" ? "" : tok.s;
  if (tok.cls === "BareQuotedString") return quoteString(tok.items.map(tokStr).join(""));
  if (tok.cls === "Comment") {
    return "(" + tok.items.map((x) => (x.type === "comment" ? tokStr(x) : tokStr(x).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"))).join("") + ")";
  }
  return tok.items.map(tokStr).join("");
}

function genericValue(items) {
  return items.map(tokValue).filter((v) => v).join("");
}

function tokValue(tok) {
  if (tok.term) return tok.kind === "v" ? tok.s : tok.kind === "w" ? " " : "";
  switch (tok.cls) {
    case "CFWSList":
    case "Comment":
      return " ";
    case "BareQuotedString":
      return tok.items.map(tokStr).join("");
    case "LocalPart":
      return tok.items[0].type === "quoted-string" ? quotedValue(tok.items[0]) : tokValue(tok.items[0]);
    case "AddrSpec":
      if (tok.items.length < 3) return tokValue(tok.items[0]);
      return rstrip(tokValue(tok.items[0])) + tokValue(tok.items[1]) + lstrip(tokValue(tok.items[2]));
    default:
      return genericValue(tok.items);
  }
}

function quotedValue(tok) {
  return tok.items.map((x) => (x.type === "bare-quoted-string" ? tokStr(x) : tokValue(x))).join("");
}

function attributeError(name, tok = null) {
  return new Error(`'${tok && !tok.term && tok.cls !== "TokenList" ? tok.cls : "str"}' object has no attribute '${name}'`);
}

function itemAt(tok, index) {
  const item = tok.items.at(index);
  if (item === undefined) throw new Error("list index out of range");
  return item;
}

function firstType(tok, index) {
  const item = tok.term ? tok.s.at(index) : tok.items.at(index);
  if (item === undefined) throw new Error("list index out of range");
  if (typeof item === "string") throw attributeError("token_type");
  return item.type;
}

function displayNameOf(tok) {
  switch (tok.cls) {
    case "DisplayName": {
      const res = [...tok.items];
      if (res.length === 0) return genericValue(res);
      if (res[0].type === "cfws") res.shift();
      else if (firstType(res[0], 0) === "cfws") res[0] = tl("TokenList", res[0].items.slice(1));
      if (!res.length) throw new Error("list index out of range");
      if (res[res.length - 1].type === "cfws") res.pop();
      else if (firstType(res[res.length - 1], -1) === "cfws") res[res.length - 1] = tl("TokenList", res[res.length - 1].items.slice(0, -1));
      return genericValue(res);
    }
    case "Address":
      return tok.items[0].type === "group" ? displayNameOf(tok.items[0]) : null;
    case "Group":
      return displayNameOf(tok.items[0]);
    case "NameAddr":
      return tok.items.length === 1 ? null : displayNameOf(tok.items[0]);
    case "Mailbox":
      return tok.items[0].type === "name-addr" ? displayNameOf(tok.items[0]) : null;
    case "InvalidMailbox":
      return null;
    default:
      throw attributeError("display_name", tok);
  }
}

function localPartOf(tok) {
  switch (tok.cls) {
    case "NameAddr":
      return localPartOf(tok.items[tok.items.length - 1]);
    case "AngleAddr": {
      const spec = tok.items.find((x) => x.type === "addr-spec");
      return spec ? localPartOf(spec) : null;
    }
    case "Mailbox":
    case "AddrSpec":
      return localPartOf(tok.items[0]);
    case "InvalidMailbox":
      return null;
    case "LocalPart": {
      const source = tok.items[0];
      if (source.term) throw attributeError("token_type");
      const res = [DOT];
      let last = DOT;
      let lastIsTl = false;
      for (const item of [...source.items, DOT]) {
        if (item.type === "cfws") continue;
        if (lastIsTl && item.type === "dot" && itemAt(last, -1).type === "cfws") {
          res[res.length - 1] = tl("TokenList", last.items.slice(0, -1));
        }
        const isTl = !item.term;
        if (isTl && last.type === "dot" && itemAt(item, 0).type === "cfws") res.push(tl("TokenList", item.items.slice(1)));
        else res.push(item);
        last = res[res.length - 1];
        lastIsTl = isTl;
      }
      return genericValue(res.slice(1, -1));
    }
    default:
      throw attributeError("local_part", tok);
  }
}

function domainOf(tok) {
  switch (tok.cls) {
    case "NameAddr":
      return domainOf(tok.items[tok.items.length - 1]);
    case "AngleAddr": {
      const spec = tok.items.find((x) => x.type === "addr-spec");
      return spec ? domainOf(spec) : null;
    }
    case "Mailbox":
      return domainOf(tok.items[0]);
    case "AddrSpec":
      return tok.items.length < 3 ? null : domainOf(tok.items[tok.items.length - 1]);
    case "InvalidMailbox":
      return null;
    case "Domain":
    case "DomainLiteral":
      return pySplit(genericValue(tok.items)).join("");
    default:
      throw attributeError("domain", tok);
  }
}

function allMailboxes(tok) {
  switch (tok.cls) {
    case "AddressList":
      return tok.items.filter((x) => x.type === "address").flatMap(allMailboxes);
    case "Address":
      if (tok.items[0].type === "mailbox" || tok.items[0].type === "invalid-mailbox") return [tok.items[0]];
      return allMailboxes(tok.items[0]);
    case "MailboxList":
      return tok.items.filter((x) => x.type === "mailbox" || x.type === "invalid-mailbox");
    case "GroupList":
      if (!tok.items.length || tok.items[0].type !== "mailbox-list") return [];
      return allMailboxes(tok.items[0]);
    case "Group":
      if (tok.items[2].type !== "group-list") return [];
      return allMailboxes(tok.items[2]);
    default:
      throw attributeError("all_mailboxes", tok);
  }
}

function wspSplit(value) {
  const m = /[ \t]+/.exec(value);
  if (!m) return [value, ""];
  return [value.slice(0, m.index), value.slice(m.index)];
}

function at0(value) {
  if (!value) throw new IndexError("string index out of range");
  return value[0];
}

function getFws(value) {
  const rest = lstrip(value);
  return [term(value.slice(0, value.length - rest.length), "fws", "w"), rest];
}

function qDecode(bytes) {
  const s = bytes.map((b) => (b === 0x5f ? 0x20 : b));
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === 0x3d && i + 2 < s.length && isHex(s[i + 1]) && isHex(s[i + 2])) {
      out.push(parseInt(String.fromCharCode(s[i + 1], s[i + 2]), 16));
      i += 2;
    } else out.push(s[i]);
  }
  return Buffer.from(out);
}

function ewDecode(ew) {
  const pieces = ew.split("?");
  if (pieces.length !== 5) throw new ValueError("not enough values to unpack");
  const charset = pieces[1].split("*")[0];
  const cte = pieces[2].toLowerCase();
  const raw = [];
  for (let i = 0; i < pieces[3].length; i += 1) {
    const c = pieces[3].charCodeAt(i);
    if (c < 0x80) raw.push(c);
    else if (c >= 0xdc80 && c <= 0xdcff) raw.push(c - 0xdc00);
    else throw new ValueError("'ascii' codec can't encode character");
  }
  let bytes;
  if (cte === "q") bytes = qDecode(raw);
  else if (cte === "b") bytes = decodeB(Buffer.from(raw));
  else throw new ValueError(`KeyError: '${cte}'`);
  try {
    return decodeBytes(bytes, charset, "strict");
  } catch (exc) {
    if (exc instanceof UnicodeDecodeError) return decodeBytes(bytes, charset, "surrogateescape");
    if (exc instanceof LookupError || exc instanceof TypeError) return decodeBytes(bytes, "ascii", "surrogateescape");
    throw exc;
  }
}

function getEncodedWord(value) {
  if (!value.startsWith("=?")) throw new HeaderParseError(`expected encoded word but found ${value}`);
  const body = value.slice(2);
  const at = body.indexOf("?=");
  if (at < 0) throw new HeaderParseError(`expected encoded word but found ${value}`);
  let tok = body.slice(0, at);
  let remstr = body.slice(at + 2);
  let rest = remstr;
  if (remstr.length > 1 && HEXDIGITS.includes(remstr[0]) && HEXDIGITS.includes(remstr[1]) && tok.split("?").length - 1 < 2) {
    const at2 = remstr.indexOf("?=");
    if (at2 < 0) {
      tok = tok + "?=" + remstr;
      rest = "";
    } else {
      tok = tok + "?=" + remstr.slice(0, at2);
      rest = remstr.slice(at2 + 2);
    }
  }
  let text;
  try {
    text = ewDecode("=?" + tok + "?=");
  } catch (exc) {
    if (exc instanceof ValueError) throw new InvalidEwError(`encoded word format invalid: '${value}'`);
    throw exc;
  }
  const ew = tl("EncodedWord");
  while (text) {
    if (WSP.includes(text[0])) {
      const [token, remaining] = getFws(text);
      ew.items.push(token);
      text = remaining;
      continue;
    }
    const [chars, remaining] = wspSplit(text);
    ew.items.push(term(chars, "vtext"));
    text = remaining;
  }
  return [ew, rest];
}

function getUnstructured(value) {
  const items = [];
  while (value) {
    if (WSP.includes(value[0])) {
      const [token, rest] = getFws(value);
      items.push(token);
      value = rest;
      continue;
    }
    let validEw = true;
    if (value.startsWith("=?")) {
      try {
        const [token, rest] = getEncodedWord(value);
        let haveWs = true;
        if (items.length > 0 && items[items.length - 1].type !== "fws") haveWs = false;
        if (haveWs && items.length > 1 && items[items.length - 2].type === "encoded-word") {
          items[items.length - 1] = term(items[items.length - 1].s, "fws", "e");
        }
        items.push(token);
        value = rest;
        continue;
      } catch (exc) {
        if (exc instanceof InvalidEwError) validEw = false;
        else if (!(exc instanceof HeaderParseError)) throw exc;
      }
    }
    let [tok, rest] = wspSplit(value);
    if (validEw && RFC2047.test(tok)) {
      const at = value.indexOf("=?");
      tok = value.slice(0, at);
      rest = value.slice(at);
    }
    items.push(term(tok, "vtext"));
    value = rest;
  }
  return items.map(tokStr).join("");
}

function getPtextToEndchars(value, endchars) {
  const [fragment, remainder] = wspSplit(value);
  const vchars = [];
  let escape = false;
  let hadQp = false;
  let pos = 0;
  let broke = false;
  for (pos = 0; pos < fragment.length; pos += 1) {
    if (fragment[pos] === "\\") {
      if (escape) {
        escape = false;
        hadQp = true;
      } else {
        escape = true;
        continue;
      }
    }
    if (escape) escape = false;
    else if (endchars.includes(fragment[pos])) {
      broke = true;
      break;
    }
    vchars.push(fragment[pos]);
  }
  if (!broke) pos = fragment.length;
  return [vchars.join(""), fragment.slice(pos) + remainder, hadQp];
}

function getQpCtext(value) {
  const [ptext, rest] = getPtextToEndchars(value, "()");
  return [term(ptext, "ptext", "w"), rest];
}

function getQcontent(value) {
  const [ptext, rest] = getPtextToEndchars(value, '"');
  return [term(ptext, "ptext"), rest];
}

function getAtext(value) {
  const m = /^[^()<>@,:;.\\"[\] \t]+/.exec(value);
  if (!m) throw new HeaderParseError(`expected atext but found '${value}'`);
  return [term(m[0], "atext"), value.slice(m[0].length)];
}

function getBareQuotedString(value) {
  if (value[0] !== '"') throw new HeaderParseError(`expected '"' but found '${value}'`);
  const bare = tl("BareQuotedString");
  value = value.slice(1);
  if (value && value[0] === '"') {
    const [token, rest] = getQcontent(value);
    bare.items.push(token);
    value = rest;
  }
  while (value && value[0] !== '"') {
    let token;
    if (WSP.includes(value[0])) {
      [token, value] = getFws(value);
    } else if (value.slice(0, 2) === "=?") {
      let validEw = false;
      try {
        [token, value] = getEncodedWord(value);
        validEw = true;
      } catch (exc) {
        if (!(exc instanceof HeaderParseError)) throw exc;
        [token, value] = getQcontent(value);
      }
      if (validEw && bare.items.length > 1) {
        const last = bare.items[bare.items.length - 1];
        if (last.type === "fws" && bare.items[bare.items.length - 2].type === "encoded-word") {
          bare.items[bare.items.length - 1] = term(last.s, "fws", "e");
        }
      }
    } else {
      [token, value] = getQcontent(value);
    }
    bare.items.push(token);
  }
  if (!value) return [bare, value];
  return [bare, value.slice(1)];
}

function getComment(value) {
  if (value && value[0] !== "(") throw new HeaderParseError(`expected '(' but found '${value}'`);
  const comment = tl("Comment");
  value = value.slice(1);
  while (value && value[0] !== ")") {
    let token;
    if (WSP.includes(value[0])) [token, value] = getFws(value);
    else if (value[0] === "(") [token, value] = getComment(value);
    else [token, value] = getQpCtext(value);
    comment.items.push(token);
  }
  if (!value) return [comment, value];
  return [comment, value.slice(1)];
}

function getCfws(value) {
  const cfws = tl("CFWSList");
  while (value && CFWS_LEADER.includes(value[0])) {
    let token;
    if (WSP.includes(value[0])) [token, value] = getFws(value);
    else [token, value] = getComment(value);
    cfws.items.push(token);
  }
  return [cfws, value];
}

function getQuotedString(value) {
  const qs = tl("QuotedString");
  let token;
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    qs.items.push(token);
  }
  [token, value] = getBareQuotedString(value);
  qs.items.push(token);
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    qs.items.push(token);
  }
  return [qs, value];
}

function getAtom(value) {
  const atom = tl("Atom");
  let token;
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    atom.items.push(token);
  }
  if (value && ATOM_ENDS.includes(value[0])) throw new HeaderParseError(`expected atom but found '${value}'`);
  if (value.startsWith("=?")) {
    try {
      [token, value] = getEncodedWord(value);
    } catch (exc) {
      if (!(exc instanceof HeaderParseError)) throw exc;
      [token, value] = getAtext(value);
    }
  } else {
    [token, value] = getAtext(value);
  }
  atom.items.push(token);
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    atom.items.push(token);
  }
  return [atom, value];
}

function getDotAtomText(value) {
  const dat = tl("DotAtomText");
  if (!value || ATOM_ENDS.includes(value[0])) throw new HeaderParseError(`expected atom at a start of dot-atom-text but found '${value}'`);
  while (value && !ATOM_ENDS.includes(value[0])) {
    let token;
    [token, value] = getAtext(value);
    dat.items.push(token);
    if (value && value[0] === ".") {
      dat.items.push(DOT);
      value = value.slice(1);
    }
  }
  if (dat.items[dat.items.length - 1] === DOT) throw new HeaderParseError(`expected atom at end of dot-atom-text but found '.${value}'`);
  return [dat, value];
}

function getDotAtom(value) {
  const da = tl("DotAtom");
  let token;
  if (CFWS_LEADER.includes(at0(value))) {
    [token, value] = getCfws(value);
    da.items.push(token);
  }
  if (value.startsWith("=?")) {
    try {
      [token, value] = getEncodedWord(value);
    } catch (exc) {
      if (!(exc instanceof HeaderParseError)) throw exc;
      [token, value] = getDotAtomText(value);
    }
  } else {
    [token, value] = getDotAtomText(value);
  }
  da.items.push(token);
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    da.items.push(token);
  }
  return [da, value];
}

function prepend(token, leader) {
  if (token.term) throw new TypeError("'str' object does not support item assignment");
  token.items.unshift(leader);
}

function getWord(value) {
  let leader = null;
  if (CFWS_LEADER.includes(at0(value))) [leader, value] = getCfws(value);
  if (!value) throw new HeaderParseError("Expected 'atom' or 'quoted-string' but found nothing.");
  let token;
  if (value[0] === '"') [token, value] = getQuotedString(value);
  else if (SPECIALS.includes(value[0])) throw new HeaderParseError(`Expected 'atom' or 'quoted-string' but found '${value}'`);
  else [token, value] = getAtom(value);
  if (leader !== null) prepend(token, leader);
  return [token, value];
}

function getPhrase(value) {
  const phrase = tl("Phrase");
  let token;
  try {
    [token, value] = getWord(value);
    phrase.items.push(token);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
  }
  while (value && !PHRASE_ENDS.includes(value[0])) {
    if (value[0] === ".") {
      phrase.items.push(DOT);
      value = value.slice(1);
    } else {
      try {
        [token, value] = getWord(value);
      } catch (exc) {
        if (!(exc instanceof HeaderParseError)) throw exc;
        if (CFWS_LEADER.includes(value[0])) [token, value] = getCfws(value);
        else throw exc;
      }
      phrase.items.push(token);
    }
  }
  return [phrase, value];
}

function getObsLocalPart(value) {
  const obs = tl("ObsLocalPart");
  while (value && (value[0] === "\\" || !PHRASE_ENDS.includes(value[0]))) {
    if (value[0] === ".") {
      obs.items.push(DOT);
      value = value.slice(1);
      continue;
    } else if (value[0] === "\\") {
      obs.items.push(term(value[0], "misplaced-special"));
      value = value.slice(1);
      continue;
    }
    let token;
    try {
      [token, value] = getWord(value);
    } catch (exc) {
      if (!(exc instanceof HeaderParseError)) throw exc;
      if (!CFWS_LEADER.includes(value[0])) throw exc;
      [token, value] = getCfws(value);
    }
    obs.items.push(token);
  }
  return [obs, value];
}

function getLocalPart(value) {
  const lp = tl("LocalPart");
  let leader = null;
  if (CFWS_LEADER.includes(at0(value))) [leader, value] = getCfws(value);
  if (!value) throw new HeaderParseError(`expected local-part but found '${value}'`);
  let token;
  try {
    [token, value] = getDotAtom(value);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
    try {
      [token, value] = getWord(value);
    } catch (exc2) {
      if (!(exc2 instanceof HeaderParseError)) throw exc2;
      if (value[0] !== "\\" && PHRASE_ENDS.includes(value[0])) throw exc2;
      token = tl("TokenList");
    }
  }
  if (leader !== null) prepend(token, leader);
  lp.items.push(token);
  if (value && (value[0] === "\\" || !PHRASE_ENDS.includes(value[0]))) {
    const [obs, rest] = getObsLocalPart(tokStr(lp) + value);
    value = rest;
    lp.items[0] = obs;
  }
  return [lp, value];
}

function getDtext(value) {
  const [ptext, rest] = getPtextToEndchars(value, "[]");
  return [term(ptext, "ptext"), rest];
}

function getDomainLiteral(value) {
  const dl = tl("DomainLiteral");
  let token;
  if (CFWS_LEADER.includes(at0(value))) {
    [token, value] = getCfws(value);
    dl.items.push(token);
  }
  if (!value) throw new HeaderParseError("expected domain-literal");
  if (value[0] !== "[") throw new HeaderParseError(`expected '[' at start of domain-literal but found '${value}'`);
  value = value.slice(1);
  const early = () => {
    if (value) return false;
    dl.items.push(EARLY_END_DEFECT);
    dl.items.push(term("]", "domain-literal-end"));
    return true;
  };
  if (early()) return [dl, value];
  dl.items.push(term("[", "domain-literal-start"));
  if (WSP.includes(at0(value))) {
    [token, value] = getFws(value);
    dl.items.push(token);
  }
  [token, value] = getDtext(value);
  dl.items.push(token);
  if (early()) return [dl, value];
  if (WSP.includes(value[0])) {
    [token, value] = getFws(value);
    dl.items.push(token);
  }
  if (early()) return [dl, value];
  if (value[0] !== "]") throw new HeaderParseError(`expected ']' at end of domain-literal but found '${value}'`);
  dl.items.push(term("]", "domain-literal-end"));
  value = value.slice(1);
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    dl.items.push(token);
  }
  return [dl, value];
}

function getDomain(value) {
  const domain = tl("Domain");
  let leader = null;
  if (CFWS_LEADER.includes(at0(value))) [leader, value] = getCfws(value);
  if (!value) throw new HeaderParseError(`expected domain but found '${value}'`);
  let token;
  if (value[0] === "[") {
    [token, value] = getDomainLiteral(value);
    if (leader !== null) prepend(token, leader);
    domain.items.push(token);
    return [domain, value];
  }
  try {
    [token, value] = getDotAtom(value);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
    [token, value] = getAtom(value);
  }
  if (value && value[0] === "@") throw new HeaderParseError("Invalid Domain");
  if (leader !== null) prepend(token, leader);
  domain.items.push(token);
  if (value && value[0] === ".") {
    if (domain.items[0].type === "dot-atom") domain.items = [...domain.items[0].items];
    while (value && value[0] === ".") {
      domain.items.push(DOT);
      [token, value] = getAtom(value.slice(1));
      domain.items.push(token);
    }
  }
  return [domain, value];
}

function getAddrSpec(value) {
  const spec = tl("AddrSpec");
  let token;
  [token, value] = getLocalPart(value);
  spec.items.push(token);
  if (!value || value[0] !== "@") return [spec, value];
  spec.items.push(term("@", "address-at-symbol"));
  [token, value] = getDomain(value.slice(1));
  spec.items.push(token);
  return [spec, value];
}

function getObsRoute(value) {
  const route = tl("ObsRoute");
  let token;
  while (value && (value[0] === "," || CFWS_LEADER.includes(value[0]))) {
    if (CFWS_LEADER.includes(value[0])) {
      [token, value] = getCfws(value);
      route.items.push(token);
    } else if (value[0] === ",") {
      route.items.push(term(",", "list-separator"));
      value = value.slice(1);
    }
  }
  if (!value || value[0] !== "@") throw new HeaderParseError(`expected obs-route domain but found '${value}'`);
  route.items.push(term("@", "route-component-marker"));
  [token, value] = getDomain(value.slice(1));
  route.items.push(token);
  while (value && value[0] === ",") {
    route.items.push(term(",", "list-separator"));
    value = value.slice(1);
    if (!value) break;
    if (CFWS_LEADER.includes(value[0])) {
      [token, value] = getCfws(value);
      route.items.push(token);
    }
    if (value[0] === "@") {
      route.items.push(term("@", "route-component-marker"));
      [token, value] = getDomain(value.slice(1));
      route.items.push(token);
    }
  }
  if (!value) throw new HeaderParseError("end of header while parsing obs-route");
  if (value[0] !== ":") throw new HeaderParseError(`expected ':' marking end of obs-route but found '${value}'`);
  route.items.push(term(":", "end-of-obs-route-marker"));
  return [route, value.slice(1)];
}

function getAngleAddr(value) {
  const angle = tl("AngleAddr");
  let token;
  if (CFWS_LEADER.includes(at0(value))) {
    [token, value] = getCfws(value);
    angle.items.push(token);
  }
  if (!value || value[0] !== "<") throw new HeaderParseError(`expected angle-addr but found '${value}'`);
  angle.items.push(term("<", "angle-addr-start"));
  value = value.slice(1);
  if (at0(value) === ">") {
    angle.items.push(term(">", "angle-addr-end"));
    return [angle, value.slice(1)];
  }
  try {
    [token, value] = getAddrSpec(value);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
    try {
      [token, value] = getObsRoute(value);
    } catch (exc2) {
      if (!(exc2 instanceof HeaderParseError)) throw exc2;
      throw new HeaderParseError(`expected addr-spec or obs-route but found '${value}'`);
    }
    angle.items.push(token);
    [token, value] = getAddrSpec(value);
  }
  angle.items.push(token);
  if (value && value[0] === ">") value = value.slice(1);
  angle.items.push(term(">", "angle-addr-end"));
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    angle.items.push(token);
  }
  return [angle, value];
}

function getDisplayName(value) {
  const [phrase, rest] = getPhrase(value);
  return [tl("DisplayName", [...phrase.items]), rest];
}

function getNameAddr(value) {
  const nameAddr = tl("NameAddr");
  let leader = null;
  if (CFWS_LEADER.includes(at0(value))) {
    [leader, value] = getCfws(value);
    if (!value) throw new HeaderParseError(`expected name-addr but found '${tokStr(leader)}'`);
  }
  let token;
  if (value[0] !== "<") {
    if (PHRASE_ENDS.includes(value[0])) throw new HeaderParseError(`expected name-addr but found '${value}'`);
    [token, value] = getDisplayName(value);
    if (!value) throw new HeaderParseError(`expected name-addr but found '${tokStr(token)}'`);
    if (leader !== null) {
      prepend(token.items[0], leader);
      leader = null;
    }
    nameAddr.items.push(token);
  }
  [token, value] = getAngleAddr(value);
  if (leader !== null) prepend(token, leader);
  nameAddr.items.push(token);
  return [nameAddr, value];
}

const EARLY_END_DEFECT = { defect: true };

function hasEarlyEndDefect(tok) {
  if (tok === EARLY_END_DEFECT) return true;
  return !tok.term && tok.items.some(hasEarlyEndDefect);
}

function getMailbox(value) {
  const mailbox = tl("Mailbox");
  let token;
  try {
    [token, value] = getNameAddr(value);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
    try {
      [token, value] = getAddrSpec(value);
    } catch (exc2) {
      if (!(exc2 instanceof HeaderParseError)) throw exc2;
      throw new HeaderParseError(`expected mailbox but found '${value}'`);
    }
  }
  if (hasEarlyEndDefect(token)) throw new Error("'InvalidHeaderDefect' object has no attribute 'all_defects'");
  mailbox.items.push(token);
  return [mailbox, value];
}

function getInvalidMailbox(value, endchars) {
  const invalid = tl("InvalidMailbox");
  while (value && !endchars.includes(value[0])) {
    if (PHRASE_ENDS.includes(value[0])) {
      invalid.items.push(term(value[0], "misplaced-special"));
      value = value.slice(1);
    } else {
      let token;
      [token, value] = getPhrase(value);
      invalid.items.push(token);
    }
  }
  return [invalid, value];
}

function getMailboxList(value) {
  const list = tl("MailboxList");
  while (value && value[0] !== ";") {
    let token;
    try {
      [token, value] = getMailbox(value);
      list.items.push(token);
    } catch (exc) {
      if (!(exc instanceof HeaderParseError)) throw exc;
      let leader = null;
      if (CFWS_LEADER.includes(value[0])) {
        [leader, value] = getCfws(value);
        if (!value || ",;".includes(value[0])) {
          list.items.push(leader);
        } else {
          [token, value] = getInvalidMailbox(value, ",;");
          if (leader !== null) prepend(token, leader);
          list.items.push(token);
        }
      } else if (value[0] !== ",") {
        [token, value] = getInvalidMailbox(value, ",;");
        list.items.push(token);
      }
    }
    if (value && !",;".includes(value[0])) {
      const mailbox = list.items[list.items.length - 1];
      mailbox.type = "invalid-mailbox";
      let token2;
      [token2, value] = getInvalidMailbox(value, ",;");
      mailbox.items.push(...token2.items);
    }
    if (value && value[0] === ",") {
      list.items.push(term(",", "list-separator"));
      value = value.slice(1);
    }
  }
  return [list, value];
}

function getGroupList(value) {
  const groupList = tl("GroupList");
  if (!value) return [groupList, value];
  let leader = null;
  if (value && CFWS_LEADER.includes(value[0])) {
    [leader, value] = getCfws(value);
    if (!value) {
      groupList.items.push(leader);
      return [groupList, value];
    }
    if (value[0] === ";") {
      groupList.items.push(leader);
      return [groupList, value];
    }
  }
  let token;
  [token, value] = getMailboxList(value);
  if (allMailboxes(token).length === 0) {
    if (leader !== null) groupList.items.push(leader);
    groupList.items.push(...token.items);
    return [groupList, value];
  }
  if (leader !== null) prepend(token, leader);
  groupList.items.push(token);
  return [groupList, value];
}

function getGroup(value) {
  const group = tl("Group");
  let token;
  [token, value] = getDisplayName(value);
  if (!value || value[0] !== ":") throw new HeaderParseError(`expected ':' at end of group display name but found '${value}'`);
  group.items.push(token);
  group.items.push(term(":", "group-display-name-terminator"));
  value = value.slice(1);
  if (value && value[0] === ";") {
    group.items.push(term(";", "group-terminator"));
    return [group, value.slice(1)];
  }
  [token, value] = getGroupList(value);
  group.items.push(token);
  if (value && value[0] !== ";") throw new HeaderParseError(`expected ';' at end of group but found ${value}`);
  group.items.push(term(";", "group-terminator"));
  value = value.slice(1);
  if (value && CFWS_LEADER.includes(value[0])) {
    [token, value] = getCfws(value);
    group.items.push(token);
  }
  return [group, value];
}

function getAddress(value) {
  const address = tl("Address");
  let token;
  try {
    [token, value] = getGroup(value);
  } catch (exc) {
    if (!(exc instanceof HeaderParseError)) throw exc;
    try {
      [token, value] = getMailbox(value);
    } catch (exc2) {
      if (!(exc2 instanceof HeaderParseError)) throw exc2;
      throw new HeaderParseError(`expected address but found '${value}'`);
    }
  }
  address.items.push(token);
  return [address, value];
}

function getAddressList(value) {
  const list = tl("AddressList");
  while (value) {
    let token;
    try {
      [token, value] = getAddress(value);
      list.items.push(token);
    } catch (exc) {
      if (!(exc instanceof HeaderParseError)) throw exc;
      let leader = null;
      if (CFWS_LEADER.includes(value[0])) {
        [leader, value] = getCfws(value);
        if (!value || value[0] === ",") {
          list.items.push(leader);
        } else {
          [token, value] = getInvalidMailbox(value, ",");
          if (leader !== null) prepend(token, leader);
          list.items.push(tl("Address", [token]));
        }
      } else if (value[0] !== ",") {
        [token, value] = getInvalidMailbox(value, ",");
        list.items.push(tl("Address", [token]));
      }
    }
    if (value && value[0] !== ",") {
      const mailbox = list.items[list.items.length - 1].items[0];
      mailbox.type = "invalid-mailbox";
      let token2;
      [token2, value] = getInvalidMailbox(value, ",");
      if (mailbox.term) throw new Error("'str' object has no attribute 'extend'");
      mailbox.items.push(...token2.items);
    }
    if (value) {
      list.items.push(term(",", "list-separator"));
      value = value.slice(1);
    }
  }
  return list;
}

function addrSpecText(username, domain) {
  let lp = username;
  if (hasAny(lp, DOT_ATOM_ENDS)) lp = quoteString(lp);
  if (domain) return lp + "@" + domain;
  if (!lp) return "<>";
  return lp;
}

function addressText(displayName, username, domain) {
  let disp = displayName;
  if (hasAny(disp, SPECIALS)) disp = quoteString(disp);
  const spec = addrSpecText(username, domain);
  if (disp) return `${disp} <${spec === "<>" ? "" : spec}>`;
  return spec;
}

function decodeAddressHeader(value) {
  const list = getAddressList(value);
  const groups = [];
  for (const addr of list.items.filter((x) => x.type === "address")) {
    const disp = displayNameOf(addr);
    const addresses = allMailboxes(addr).map((mb) => addressText(displayNameOf(mb) || "", localPartOf(mb) || "", domainOf(mb) || ""));
    if (disp === null && addresses.length === 1) groups.push(addresses[0]);
    else {
      let d = disp;
      if (d !== null && hasAny(d, SPECIALS)) d = quoteString(d);
      const joined = addresses.join(", ");
      groups.push(`${d === null ? "None" : d}:${joined ? " " + joined : joined};`);
    }
  }
  return sanitize(groups.join(", "));
}

class AddrlistParser {
  constructor(field) {
    this.specials = '()<>@,:;."[]';
    this.pos = 0;
    this.LWS = " \t";
    this.CR = "\r\n";
    this.FWS = this.LWS + this.CR;
    this.atomends = this.specials + this.LWS + this.CR;
    this.phraseends = this.atomends.replace(".", "");
    this.field = field;
    this.commentlist = [];
  }

  at() {
    return this.field[this.pos];
  }

  gotonext() {
    const wslist = [];
    while (this.pos < this.field.length) {
      const c = this.at();
      if ((this.LWS + "\n\r").includes(c)) {
        if (!"\n\r".includes(c)) wslist.push(c);
        this.pos += 1;
      } else if (c === "(") {
        this.commentlist.push(this.getcomment());
      } else break;
    }
    return wslist.join("");
  }

  getaddrlist() {
    const result = [];
    while (this.pos < this.field.length) {
      const ad = this.getaddress();
      if (ad.length) result.push(...ad);
      else result.push(["", ""]);
    }
    return result;
  }

  getaddress() {
    this.commentlist = [];
    this.gotonext();
    const oldpos = this.pos;
    const oldcl = this.commentlist;
    const plist = this.getphraselist();
    this.gotonext();
    let returnlist = [];
    if (this.pos >= this.field.length) {
      if (plist.length) returnlist = [[this.commentlist.join(" "), plist[0]]];
    } else if (".@".includes(this.at())) {
      this.pos = oldpos;
      this.commentlist = oldcl;
      const addrspec = this.getaddrspec();
      returnlist = [[this.commentlist.join(" "), addrspec]];
    } else if (this.at() === ":") {
      returnlist = [];
      const fieldlen = this.field.length;
      this.pos += 1;
      while (this.pos < this.field.length) {
        this.gotonext();
        if (this.pos < fieldlen && this.at() === ";") {
          this.pos += 1;
          break;
        }
        returnlist = returnlist.concat(this.getaddress());
      }
    } else if (this.at() === "<") {
      const routeaddr = this.getrouteaddr();
      if (this.commentlist.length) returnlist = [[plist.join(" ") + " (" + this.commentlist.join(" ") + ")", routeaddr]];
      else returnlist = [[plist.join(" "), routeaddr]];
    } else if (plist.length) {
      returnlist = [[this.commentlist.join(" "), plist[0]]];
    } else if (this.specials.includes(this.at())) {
      this.pos += 1;
    }
    this.gotonext();
    if (this.pos < this.field.length && this.at() === ",") this.pos += 1;
    return returnlist;
  }

  getrouteaddr() {
    if (this.at() !== "<") return undefined;
    let expectroute = false;
    this.pos += 1;
    this.gotonext();
    let adlist = "";
    while (this.pos < this.field.length) {
      if (expectroute) {
        this.getdomain();
        expectroute = false;
      } else if (this.at() === ">") {
        this.pos += 1;
        break;
      } else if (this.at() === "@") {
        this.pos += 1;
        expectroute = true;
      } else if (this.at() === ":") {
        this.pos += 1;
      } else {
        adlist = this.getaddrspec();
        this.pos += 1;
        break;
      }
      this.gotonext();
    }
    return adlist;
  }

  getaddrspec() {
    const aslist = [];
    this.gotonext();
    while (this.pos < this.field.length) {
      let preserveWs = true;
      const c = this.at();
      if (c === ".") {
        if (aslist.length && !strip(aslist[aslist.length - 1])) aslist.pop();
        aslist.push(".");
        this.pos += 1;
        preserveWs = false;
      } else if (c === '"') {
        aslist.push('"' + this.getquote().replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
      } else if (this.atomends.includes(c)) {
        if (aslist.length && !strip(aslist[aslist.length - 1])) aslist.pop();
        break;
      } else {
        aslist.push(this.getatom());
      }
      const ws = this.gotonext();
      if (preserveWs && ws) aslist.push(ws);
    }
    if (this.pos >= this.field.length || this.at() !== "@") return aslist.join("");
    aslist.push("@");
    this.pos += 1;
    this.gotonext();
    const domain = this.getdomain();
    if (!domain) return "";
    return aslist.join("") + domain;
  }

  getdomain() {
    const sdlist = [];
    while (this.pos < this.field.length) {
      const c = this.at();
      if (this.LWS.includes(c)) this.pos += 1;
      else if (c === "(") this.commentlist.push(this.getcomment());
      else if (c === "[") sdlist.push(this.getdomainliteral());
      else if (c === ".") {
        this.pos += 1;
        sdlist.push(".");
      } else if (c === "@") return "";
      else if (this.atomends.includes(c)) break;
      else sdlist.push(this.getatom());
    }
    return sdlist.join("");
  }

  getdelimited(beginchar, endchars, allowcomments = true) {
    if (this.at() !== beginchar) return "";
    const slist = [""];
    let quote = false;
    this.pos += 1;
    while (this.pos < this.field.length) {
      const c = this.at();
      if (quote) {
        slist.push(c);
        quote = false;
      } else if (endchars.includes(c)) {
        this.pos += 1;
        break;
      } else if (allowcomments && c === "(") {
        slist.push(this.getcomment());
        continue;
      } else if (c === "\\") {
        quote = true;
      } else {
        slist.push(c);
      }
      this.pos += 1;
    }
    return slist.join("");
  }

  getquote() {
    return this.getdelimited('"', '"\r', false);
  }

  getcomment() {
    return this.getdelimited("(", ")\r", true);
  }

  getdomainliteral() {
    return "[" + this.getdelimited("[", "]\r", false) + "]";
  }

  getatom(atomends = null) {
    const ends = atomends === null ? this.atomends : atomends;
    const atomlist = [""];
    while (this.pos < this.field.length) {
      if (ends.includes(this.at())) break;
      atomlist.push(this.at());
      this.pos += 1;
    }
    return atomlist.join("");
  }

  getphraselist() {
    const plist = [];
    while (this.pos < this.field.length) {
      const c = this.at();
      if (this.FWS.includes(c)) this.pos += 1;
      else if (c === '"') plist.push(this.getquote());
      else if (c === "(") this.commentlist.push(this.getcomment());
      else if (this.phraseends.includes(c)) break;
      else plist.push(this.getatom(this.phraseends));
    }
    return plist;
  }
}

export function parseaddr(addr) {
  const field = String(addr);
  const addrs = field ? new AddrlistParser(field).getaddrlist() : [];
  return addrs.length ? addrs[0] : ["", ""];
}

const MONTHNAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYNAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIMEZONES = { UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700 };

function parsedateTz(data) {
  if (!data) return null;
  let parts = pySplit(data);
  if (!parts.length) return null;
  if (parts[0].endsWith(",") || DAYNAMES.includes(parts[0].toLowerCase())) parts.shift();
  else {
    const i = parts[0].lastIndexOf(",");
    if (i >= 0) parts[0] = parts[0].slice(i + 1);
  }
  if (parts.length === 3) {
    const stuff = parts[0].split("-");
    if (stuff.length === 3) parts = [...stuff, ...parts.slice(1)];
  }
  if (parts.length === 4) {
    const s = parts[3];
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) parts.splice(3, 1, s.slice(0, i), s.slice(i));
    else parts.push("");
  }
  if (parts.length < 5) return null;
  let [dd, mm, yy, tm, tz] = parts.slice(0, 5);
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MONTHNAMES.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTHNAMES.includes(mm)) return null;
  }
  let month = MONTHNAMES.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!/^\d/.test(yy)) [yy, tz] = [tz, yy];
  if (tm.endsWith(",")) tm = tm.slice(0, -1);
  let tmParts = tm.split(":");
  let thh;
  let tmm;
  let tss;
  if (tmParts.length === 2) [thh, tmm, tss] = [...tmParts, "0"];
  else if (tmParts.length === 3) [thh, tmm, tss] = tmParts;
  else if (tmParts.length === 1 && tmParts[0].includes(".")) {
    tmParts = tmParts[0].split(".");
    if (tmParts.length === 2) [thh, tmm, tss] = [...tmParts, 0];
    else if (tmParts.length === 3) [thh, tmm, tss] = tmParts;
    else return null;
  } else return null;
  let year;
  let day;
  try {
    year = pyInt(yy);
    day = pyInt(dd);
    thh = pyInt(thh);
    tmm = pyInt(tmm);
    tss = pyInt(tss);
  } catch {
    return null;
  }
  if (year < 100) year += year > 68 ? 1900 : 2000;
  let tzoffset = null;
  const zone = tz.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TIMEZONES, zone)) tzoffset = TIMEZONES[zone];
  else {
    try {
      tzoffset = pyInt(zone);
    } catch {}
    if (tzoffset === 0 && zone.startsWith("-")) tzoffset = null;
  }
  if (tzoffset) {
    const sign = tzoffset < 0 ? -1 : 1;
    const size = Math.abs(tzoffset);
    tzoffset = sign * (Math.floor(size / 100) * 3600 + (size % 100) * 60);
  }
  return [year, month, day, thh, tmm, tss, tzoffset];
}

function daysInMonth(year, month) {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parsedateToDatetime(data) {
  const parsed = parsedateTz(data);
  if (parsed === null) throw new ValueError(`Invalid date value or format "${data}"`);
  const [year, month, day, hour, minute, second, tz] = parsed;
  if (!(year >= 1 && year <= 9999)) throw new ValueError(`year ${year} is out of range`);
  if (!(month >= 1 && month <= 12)) throw new ValueError("month must be in 1..12");
  if (!(day >= 1 && day <= daysInMonth(year, month))) throw new ValueError("day is out of range for month");
  if (!(hour >= 0 && hour <= 23)) throw new ValueError("hour must be in 0..23");
  if (!(minute >= 0 && minute <= 59)) throw new ValueError("minute must be in 0..59");
  if (!(second >= 0 && second <= 59)) throw new ValueError("second must be in 0..59");
  if (tz !== null && !(tz > -86400 && tz < 86400)) throw new ValueError("offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24)");
  return { year, month, day, hour, minute, second, tz };
}

function utcWallMs(year, month, day, hour, minute, second) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

function localOffsetSeconds(local) {
  return Math.round((utcWallMs(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()) - (local.getTime() - local.getMilliseconds())) / 1000);
}

function localIsoWithOffset(dt) {
  const wall = utcWallMs(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
  let instant;
  if (dt.tz === null) {
    const d = new Date(2000, 0, 1);
    d.setFullYear(dt.year, dt.month - 1, dt.day);
    d.setHours(dt.hour, dt.minute, dt.second, 0);
    instant = d.getTime();
    if (d.getHours() !== dt.hour || d.getMinutes() !== dt.minute || d.getSeconds() !== dt.second || d.getDate() !== dt.day) {
      instant = wall - localOffsetSeconds(d) * 1000;
    }
  } else {
    instant = wall - dt.tz * 1000;
  }
  const local = new Date(instant);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offset = localOffsetSeconds(local);
  const size = Math.abs(offset);
  let zone = `${offset < 0 ? "-" : "+"}${pad(Math.floor(size / 3600))}:${pad(Math.floor((size % 3600) / 60))}`;
  if (size % 60) zone += `:${pad(size % 60)}`;
  return `${pad(local.getFullYear(), 4)}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}${zone}`;
}

class MimePart {
  constructor() {
    this.headers = [];
    this.payload = null;
    this.defaultType = "text/plain";
    this.preamble = null;
    this.epilogue = null;
  }
}

const HEADER_RE = /^(From |[\x21-\x39\x3b-\x7e]*:|[\t ])/;
const NL_START = /^(\r\n|\r|\n)/;
const NL_END = /(\r\n|\r|\n)$/;

function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

class LineInput {
  constructor(lines) {
    this.lines = lines;
    this.pos = 0;
    this.pushed = [];
    this.eofstack = [];
  }

  readline() {
    let line;
    if (this.pushed.length) line = this.pushed.pop();
    else if (this.pos < this.lines.length) line = this.lines[this.pos++];
    else return "";
    for (let k = this.eofstack.length - 1; k >= 0; k -= 1) {
      if (this.eofstack[k](line)) {
        this.pushed.push(line);
        return "";
      }
    }
    return line;
  }

  unreadline(line) {
    this.pushed.push(line);
  }

  rest() {
    const out = [];
    for (;;) {
      const line = this.readline();
      if (line === "") return out;
      out.push(line);
    }
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function parseHeaders(input, msg, lines) {
  let lastheader = "";
  let lastvalue = [];
  const flush = () => {
    const first = lastvalue[0];
    const at = first.indexOf(":");
    const name = first.slice(0, at);
    const value = (first.slice(at + 1).replace(/^[ \t]+/, "") + lastvalue.slice(1).join("")).replace(/[\r\n]+$/, "");
    msg.headers.push([name, value]);
  };
  for (let lineno = 0; lineno < lines.length; lineno += 1) {
    const line = lines[lineno];
    if (line[0] === " " || line[0] === "\t") {
      if (!lastheader) continue;
      lastvalue.push(line);
      continue;
    }
    if (lastheader) {
      flush();
      lastheader = "";
      lastvalue = [];
    }
    if (line.startsWith("From ")) {
      if (lineno === 0) continue;
      if (lineno === lines.length - 1) {
        input.unreadline(line);
        return;
      }
      continue;
    }
    const at = line.indexOf(":");
    if (at === 0) continue;
    lastheader = line.slice(0, at);
    lastvalue = [line];
  }
  if (lastheader) flush();
}

function parseGen(input, state) {
  const msg = new MimePart();
  if (state.cur && getContentType(state.cur) === "multipart/digest") msg.defaultType = "message/rfc822";
  if (state.stack.length) {
    const parent = state.stack[state.stack.length - 1];
    if (parent.payload === null) parent.payload = [msg];
    else parent.payload.push(msg);
  }
  state.stack.push(msg);
  state.cur = msg;
  state.last = msg;
  if (!state.root) state.root = msg;
  const headers = [];
  for (;;) {
    const line = input.readline();
    if (line === "") break;
    if (!HEADER_RE.test(line)) {
      if (!NL_START.test(line)) input.unreadline(line);
      break;
    }
    headers.push(line);
  }
  parseHeaders(input, msg, headers);
  const ctype = getContentType(msg);
  const maintype = ctype.split("/")[0];
  const pop = () => {
    const out = state.stack.pop();
    state.cur = state.stack.length ? state.stack[state.stack.length - 1] : null;
    return out;
  };
  if (ctype === "message/delivery-status") {
    for (;;) {
      input.eofstack.push((line) => NL_START.test(line));
      parseGen(input, state);
      pop();
      input.eofstack.pop();
      input.readline();
      const line = input.readline();
      if (line === "") break;
      input.unreadline(line);
    }
    return;
  }
  if (maintype === "message") {
    parseGen(input, state);
    pop();
    return;
  }
  if (maintype === "multipart") {
    const boundary = getBoundary(msg);
    if (boundary === null) {
      msg.payload = input.rest().join("");
      return;
    }
    const boundaryRe = new RegExp("^(" + escapeRegex("--" + boundary) + ")(--)?([ \\t]*)(\\r\\n|\\r|\\n)?$");
    let capturingPreamble = true;
    const preamble = [];
    let linesep = false;
    let closeBoundarySeen = false;
    for (;;) {
      let line = input.readline();
      if (line === "") break;
      const mo = boundaryRe.exec(line);
      if (mo) {
        if (mo[2]) {
          closeBoundarySeen = true;
          linesep = mo[4];
          break;
        }
        if (capturingPreamble) {
          if (preamble.length) {
            const lastline = preamble[preamble.length - 1];
            const eol = NL_END.exec(lastline);
            if (eol) preamble[preamble.length - 1] = lastline.slice(0, lastline.length - eol[0].length);
            msg.preamble = preamble.join("");
          }
          capturingPreamble = false;
          input.unreadline(line);
          continue;
        }
        for (;;) {
          line = input.readline();
          if (!boundaryRe.test(line)) {
            input.unreadline(line);
            break;
          }
        }
        input.eofstack.push((l) => boundaryRe.test(l));
        parseGen(input, state);
        const last = state.last;
        if (getContentType(last).split("/")[0] === "multipart") {
          const epilogue = last.epilogue;
          if (epilogue === "") last.epilogue = null;
          else if (epilogue !== null) {
            const eol = NL_END.exec(epilogue);
            if (eol) last.epilogue = epilogue.slice(0, epilogue.length - eol[0].length);
          }
        } else if (typeof last.payload === "string") {
          const eol = NL_END.exec(last.payload);
          if (eol) last.payload = last.payload.slice(0, last.payload.length - eol[0].length);
        }
        input.eofstack.pop();
        pop();
        state.last = state.cur;
      } else {
        preamble.push(line);
      }
    }
    if (capturingPreamble) {
      msg.payload = preamble.join("");
      input.rest();
      msg.epilogue = "";
      return;
    }
    if (!closeBoundarySeen) return;
    const epilogue = linesep ? [""] : [];
    epilogue.push(...input.rest());
    if (epilogue.length) {
      const bol = NL_START.exec(epilogue[0]);
      if (bol) epilogue[0] = epilogue[0].slice(bol[0].length);
    }
    msg.epilogue = epilogue.join("");
    return;
  }
  msg.payload = input.rest().join("");
}

function parseBytes(buf) {
  const input = new LineInput(splitLines(bytesToEscaped(buf)));
  const state = { stack: [], cur: null, last: null, root: null };
  parseGen(input, state);
  return state.root;
}

function rawHeader(msg, name) {
  const key = name.toLowerCase();
  for (const [k, v] of msg.headers) if (k.toLowerCase() === key) return v.replace(/[\r\n]/g, "");
  return null;
}

function headerText(msg, name) {
  const raw = rawHeader(msg, name);
  if (raw === null) return null;
  const key = name.toLowerCase();
  if (key === "content-type" || key === "content-disposition" || key === "content-transfer-encoding") return sanitize(raw);
  if (key === "from") return decodeAddressHeader(raw);
  return sanitize(getUnstructured(raw));
}

function isMultipart(msg) {
  return Array.isArray(msg.payload);
}

function splitparam(value) {
  const at = value.indexOf(";");
  if (at < 0) return [strip(value), null];
  return [strip(value.slice(0, at)), strip(value.slice(at + 1))];
}

function getContentType(msg) {
  const value = headerText(msg, "content-type");
  if (value === null) return msg.defaultType;
  const ctype = splitparam(value)[0].toLowerCase();
  if (ctype.split("/").length - 1 !== 1) return "text/plain";
  return ctype;
}

function getContentDisposition(msg) {
  const value = headerText(msg, "content-disposition");
  if (value === null) return null;
  return splitparam(value)[0].toLowerCase();
}

function isAttachment(msg) {
  const value = headerText(msg, "content-disposition");
  if (value === null || !value) return false;
  const m = /^[ \t]*(?:\([^)]*\)[ \t]*)*([^ \t()<>@,;:\\"/[\]?=]+)/.exec(value);
  return m !== null && strip(m[1]).toLowerCase() === "attachment";
}

function parseParam(s) {
  s = ";" + s;
  const plist = [];
  const count = (str, sub, end) => {
    let n = 0;
    let at = str.indexOf(sub);
    while (at >= 0 && at + sub.length <= end) {
      n += 1;
      at = str.indexOf(sub, at + sub.length);
    }
    return n;
  };
  while (s.slice(0, 1) === ";") {
    s = s.slice(1);
    let end = s.indexOf(";");
    while (end > 0 && (count(s, '"', end) - count(s, '\\"', end)) % 2) end = s.indexOf(";", end + 1);
    if (end < 0) end = s.length;
    let f = s.slice(0, end);
    const eq = f.indexOf("=");
    if (eq >= 0) f = strip(f.slice(0, eq)).toLowerCase() + "=" + strip(f.slice(eq + 1));
    plist.push(strip(f));
    s = s.slice(end);
  }
  return plist;
}

function unquote(str) {
  if (str.length > 1) {
    if (str.startsWith('"') && str.endsWith('"')) return str.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    if (str.startsWith("<") && str.endsWith(">")) return str.slice(1, -1);
  }
  return str;
}

function quoteParam(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function urlUnquoteLatin1(s) {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeParams(params) {
  const out = [params[0]];
  const rfc = new Map();
  for (const [name, raw] of params.slice(1)) {
    const encoded = name.endsWith("*");
    const value = unquote(raw);
    const mo = /^([A-Za-z0-9_]+)\*(([0-9]+)\*?)?$/.exec(name);
    if (mo) {
      if (!rfc.has(mo[1])) rfc.set(mo[1], []);
      rfc.get(mo[1]).push([mo[3] !== undefined ? Number(mo[3]) : null, value, encoded]);
    } else {
      out.push([name, '"' + quoteParam(value) + '"']);
    }
  }
  for (const [name, continuations] of rfc) {
    continuations.sort((a, b) => {
      if ((a[0] === null) !== (b[0] === null)) throw new TypeError("'<' not supported between instances of 'int' and 'NoneType'");
      if (a[0] !== b[0]) return a[0] - b[0];
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return Number(a[2]) - Number(b[2]);
    });
    const pieces = [];
    let extended = false;
    for (const [, s, encoded] of continuations) {
      if (encoded) {
        pieces.push(urlUnquoteLatin1(s));
        extended = true;
      } else pieces.push(s);
    }
    const value = quoteParam(pieces.join(""));
    if (extended) {
      const split = splitMax(value, "'", 2);
      if (split.length <= 2) out.push([name, [null, null, '"' + value + '"']]);
      else out.push([name, [split[0], split[1], '"' + split[2] + '"']]);
    } else out.push([name, '"' + value + '"']);
  }
  return out;
}

const MISSING = Symbol("missing");

function getParam(msg, param, failobj = null, header = "content-type") {
  const value = headerText(msg, header);
  if (value === null) return failobj;
  const params = parseParam(value).map((p) => {
    const at = p.indexOf("=");
    if (at < 0) return [strip(p), ""];
    return [strip(p.slice(0, at)), strip(p.slice(at + 1))];
  });
  for (const [k, v] of decodeParams(params)) {
    if (k.toLowerCase() === param.toLowerCase()) return Array.isArray(v) ? [v[0], v[1], unquote(v[2])] : unquote(v);
  }
  return failobj;
}

function rawUnicodeEscapeBytes(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 256) out.push(c);
    else for (const b of Buffer.from(c < 0x10000 ? `\\u${c.toString(16).padStart(4, "0")}` : `\\U${c.toString(16).padStart(8, "0")}`, "latin1")) out.push(b);
  }
  return Buffer.from(out);
}

function getContentCharset(msg, failobj = null) {
  let charset = getParam(msg, "charset", MISSING);
  if (charset === MISSING) return failobj;
  if (Array.isArray(charset)) {
    const pcharset = charset[0] || "us-ascii";
    try {
      charset = decodeBytes(rawUnicodeEscapeBytes(charset[2]), pcharset, "strict");
    } catch (exc) {
      if (!(exc instanceof LookupError || exc instanceof ValueError)) throw exc;
      charset = charset[2];
    }
  }
  if (/[^\x00-\x7f]/.test(charset)) return failobj;
  return charset.toLowerCase();
}

function getBoundary(msg) {
  const boundary = getParam(msg, "boundary", MISSING);
  if (boundary === MISSING) return null;
  let value;
  if (!Array.isArray(boundary)) value = unquote(boundary);
  else {
    const charset = boundary[0] === null ? "us-ascii" : boundary[0];
    try {
      value = decodeBytes(rawUnicodeEscapeBytes(boundary[2]), charset, "replace");
    } catch (exc) {
      if (!(exc instanceof LookupError)) throw exc;
      value = unquote(boundary[2]);
    }
  }
  return rstrip(value);
}

function getPayloadDecoded(msg) {
  if (isMultipart(msg)) return null;
  const payload = msg.payload;
  const cteHeader = headerText(msg, "content-transfer-encoding");
  const cte = (cteHeader === null ? "" : cteHeader).toLowerCase();
  if (typeof payload !== "string") {
    if (cte === "quoted-printable" || cte === "base64") throw new Error("local variable 'bpayload' referenced before assignment");
    return payload;
  }
  const bytes = escapedToBytes(payload);
  if (cte === "quoted-printable") return a2bQp(bytes);
  if (cte === "base64") return decodeB(bytesSplitlinesJoin(bytes));
  return bytes;
}

function getContent(part) {
  const ctype = getContentType(part);
  const maintype = ctype.split("/")[0];
  if (maintype === "text") {
    const content = getPayloadDecoded(part);
    const charset = getParam(part, "charset", "ASCII");
    if (content === null) throw new TypeError("'NoneType' object has no attribute 'decode'");
    return decodeBytes(content, charset, "replace");
  }
  if (["audio", "image", "video", "application"].includes(maintype)) return getPayloadDecoded(part);
  throw new Error(`KeyError: '${ctype}'`);
}

function partText(part) {
  let content;
  try {
    content = getContent(part);
  } catch {
    try {
      const payload = getPayloadDecoded(part) || Buffer.alloc(0);
      const charset = getContentCharset(part) || "utf-8";
      content = decodeBytes(payload, charset, "replace");
    } catch {
      content = "";
    }
  }
  if (Buffer.isBuffer(content)) content = decodeBytes(content, getContentCharset(part) || "utf-8", "replace");
  return content === null ? "None" : String(content);
}

function* findBody(root, part, preferencelist) {
  if (isAttachment(part)) return;
  const [maintype, subtype] = getContentType(part).split("/");
  if (maintype === "text") {
    if (preferencelist.includes(subtype)) yield [preferencelist.indexOf(subtype), part];
    return;
  }
  if (maintype !== "multipart" || !isMultipart(root)) return;
  const subparts = isMultipart(part) ? part.payload : [];
  if (subtype !== "related") {
    for (const subpart of subparts) yield* findBody(root, subpart, preferencelist);
    return;
  }
  if (preferencelist.includes("related")) yield [preferencelist.indexOf("related"), part];
  let candidate = null;
  const start = getParam(part, "start");
  if (truthy(start)) {
    for (const subpart of subparts) {
      if (headerText(subpart, "content-id") === start) {
        candidate = subpart;
        break;
      }
    }
  }
  if (candidate === null) {
    const payload = part.payload;
    candidate = truthy(payload) ? payload[0] : null;
  }
  if (candidate !== null) yield* findBody(root, candidate, preferencelist);
}

function getBody(msg, preferencelist) {
  let best = preferencelist.length;
  let body = null;
  for (const [prio, part] of findBody(msg, msg, preferencelist)) {
    if (prio < best) {
      best = prio;
      body = part;
      if (prio === 0) break;
    }
  }
  return body;
}

const ENTITIES = new Map();
for (const pair of ENTITY_LIST.split(",")) {
  const [name, codes] = pair.split(":");
  ENTITIES.set(name + ";", String.fromCodePoint(...codes.split(".").map((h) => parseInt(h, 16))));
}
for (const name of LEGACY_ENTITIES.split(" ")) ENTITIES.set(name, ENTITIES.get(name + ";"));
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function invalidCodepoint(num) {
  return INVALID_CODEPOINTS.some(([a, b]) => num >= a && num <= b);
}

function replaceCharref(s) {
  if (s[0] === "#") {
    const num = s[1] === "x" || s[1] === "X" ? parseInt(s.slice(2).replace(/;+$/, ""), 16) : parseInt(s.slice(1).replace(/;+$/, ""), 10);
    if (Object.prototype.hasOwnProperty.call(INVALID_CHARREFS, num)) return String.fromCodePoint(INVALID_CHARREFS[num]);
    if ((num >= 0xd800 && num <= 0xdfff) || !(num <= 0x10ffff)) return "�";
    if (invalidCodepoint(num)) return "";
    return String.fromCodePoint(num);
  }
  if (ENTITIES.has(s)) return ENTITIES.get(s);
  const chars = Array.from(s);
  for (let x = chars.length - 1; x > 1; x -= 1) {
    const prefix = chars.slice(0, x).join("");
    if (ENTITIES.has(prefix)) return ENTITIES.get(prefix) + chars.slice(x).join("");
  }
  return "&" + s;
}

function htmlUnescape(s) {
  if (!s.includes("&")) return s;
  return s.replace(CHARREF, (_, group) => replaceCharref(group));
}

const NOT_WS = `[^${WS}`;
const RX = {
  starttagopen: /<[a-zA-Z]/y,
  tagfind: new RegExp(`([a-zA-Z][^\\t\\n\\r\\f />\\x00]*)(?:[${WS}]|/(?!>))*`, "y"),
  attrfind: new RegExp(
    `((?<=['"${WS}/])${NOT_WS}/>]${NOT_WS}/=>]*)([${WS}]*=+[${WS}]*('[^']*'|"[^"]*"|(?!['"])${NOT_WS}>]*))?(?:[${WS}]|/(?!>))*`,
    "y",
  ),
  locatestarttagend: new RegExp(
    `<[a-zA-Z][^\\t\\n\\r\\f />\\x00]*(?:[${WS}/]*(?:(?<=['"${WS}/])${NOT_WS}/>]${NOT_WS}/=>]*(?:[${WS}]*=+[${WS}]*(?:'[^']*'|"[^"]*"|(?!['"])${NOT_WS}>]*)[${WS}]*)?(?:[${WS}]|/(?!>))*)*)?[${WS}]*`,
    "y",
  ),
  endtagfind: new RegExp(`</[${WS}]*([a-zA-Z][-.a-zA-Z0-9:_]*)[${WS}]*>`, "y"),
  commentclose: new RegExp(`--[${WS}]*>`, "g"),
  markedsectionclose: new RegExp(`][${WS}]*][${WS}]*>`, "g"),
  msmarkedsectionclose: new RegExp(`][${WS}]*>`, "g"),
  declname: new RegExp(`[a-zA-Z][-_.a-zA-Z0-9]*[${WS}]*`, "y"),
  spaceOrSemicolon: new RegExp(`[${WS};]`),
};

function matchAt(rx, text, pos) {
  rx.lastIndex = pos;
  const m = rx.exec(text);
  return m ? { m, end: rx.lastIndex } : null;
}

function searchFrom(rx, text, pos) {
  rx.lastIndex = pos;
  const m = rx.exec(text);
  return m ? { start: m.index, end: rx.lastIndex } : null;
}

class HtmlTextExtractor {
  constructor() {
    this.parts = [];
    this.skip = 0;
    this.cdata = null;
    this.interesting = null;
  }

  starttag(tag) {
    if (["style", "script", "title", "head"].includes(tag)) this.skip += 1;
    else if (["br", "p", "div", "tr", "li", "hr"].includes(tag)) this.parts.push("\n");
    else if (tag === "td" || tag === "th") this.parts.push(" ");
  }

  endtag(tag) {
    if (["style", "script", "title", "head"].includes(tag) && this.skip) this.skip -= 1;
  }

  data(text) {
    if (!this.skip) this.parts.push(text);
  }

  feed(raw) {
    this.raw = raw;
    const n = raw.length;
    let i = 0;
    while (i < n) {
      let j;
      if (this.cdata === null) {
        j = raw.indexOf("<", i);
        if (j < 0) {
          const last = raw.lastIndexOf("&");
          const amppos = last >= Math.max(i, n - 34) ? last : -1;
          if (amppos >= 0 && !RX.spaceOrSemicolon.test(raw.slice(amppos))) break;
          j = n;
        }
      } else {
        const found = searchFrom(this.interesting, raw, i);
        if (!found) break;
        j = found.start;
      }
      if (i < j) this.data(this.cdata === null ? htmlUnescape(raw.slice(i, j)) : raw.slice(i, j));
      i = j;
      if (i === n) break;
      let k;
      if (matchAt(RX.starttagopen, raw, i)) k = this.parseStarttag(i);
      else if (raw.startsWith("</", i)) k = this.parseEndtag(i);
      else if (raw.startsWith("<!--", i)) k = this.parseComment(i);
      else if (raw.startsWith("<?", i)) {
        const gt = raw.indexOf(">", i + 2);
        k = gt < 0 ? -1 : gt + 1;
      } else if (raw.startsWith("<!", i)) k = this.parseHtmlDeclaration(i);
      else if (i + 1 < n) {
        this.data("<");
        k = i + 1;
      } else break;
      if (k < 0) break;
      i = k;
    }
    return this.parts.join("");
  }

  parseComment(i) {
    const found = searchFrom(RX.commentclose, this.raw, i + 4);
    return found ? found.end : -1;
  }

  parseBogusComment(i) {
    const pos = this.raw.indexOf(">", i + 2);
    return pos < 0 ? -1 : pos + 1;
  }

  parseHtmlDeclaration(i) {
    const raw = this.raw;
    if (raw.slice(i, i + 4) === "<!--") return this.parseComment(i);
    if (raw.slice(i, i + 3) === "<![") return this.parseMarkedSection(i);
    if (raw.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const gt = raw.indexOf(">", i + 9);
      return gt < 0 ? -1 : gt + 1;
    }
    return this.parseBogusComment(i);
  }

  parseMarkedSection(i) {
    const raw = this.raw;
    const start = i + 3;
    if (start === raw.length) return -1;
    const named = matchAt(RX.declname, raw, start);
    if (!named) throw new Error(`expected name token at ${pyRepr(raw.slice(i, i + 20))}`);
    if (named.end === raw.length) return -1;
    const name = strip(named.m[0]).toLowerCase();
    let found;
    if (["temp", "cdata", "ignore", "include", "rcdata"].includes(name)) found = searchFrom(RX.markedsectionclose, raw, start);
    else if (["if", "else", "endif"].includes(name)) found = searchFrom(RX.msmarkedsectionclose, raw, start);
    else throw new Error(`unknown status keyword ${pyRepr(raw.slice(start, named.end))} in marked section`);
    return found ? found.end : -1;
  }

  checkForWholeStartTag(i) {
    const raw = this.raw;
    const found = matchAt(RX.locatestarttagend, raw, i);
    if (!found) throw new Error("we should not get here!");
    const j = found.end;
    const next = raw.slice(j, j + 1);
    if (next === ">") return j + 1;
    if (next === "/") return raw.startsWith("/>", j) ? j + 2 : -1;
    if (next === "") return -1;
    if ("abcdefghijklmnopqrstuvwxyz=/ABCDEFGHIJKLMNOPQRSTUVWXYZ".includes(next)) return -1;
    return j > i ? j : i + 1;
  }

  parseStarttag(i) {
    const raw = this.raw;
    const endpos = this.checkForWholeStartTag(i);
    if (endpos < 0) return endpos;
    const found = matchAt(RX.tagfind, raw, i + 1);
    let k = found.end;
    const tag = found.m[1].toLowerCase();
    while (k < endpos) {
      const attr = matchAt(RX.attrfind, raw, k);
      if (!attr) break;
      k = attr.end;
    }
    const end = strip(raw.slice(k, endpos));
    if (end !== ">" && end !== "/>") {
      this.data(raw.slice(i, endpos));
      return endpos;
    }
    if (end.endsWith("/>")) {
      this.starttag(tag);
      this.endtag(tag);
    } else {
      this.starttag(tag);
      if (tag === "script" || tag === "style") {
        this.cdata = tag;
        this.interesting = new RegExp(`</[${WS}]*${tag}[${WS}]*>`, "gi");
      }
    }
    return endpos;
  }

  parseEndtag(i) {
    const raw = this.raw;
    const gt = raw.indexOf(">", i + 1);
    if (gt < 0) return -1;
    let gtpos = gt + 1;
    const found = matchAt(RX.endtagfind, raw, i);
    if (!found) {
      if (this.cdata !== null) {
        this.data(raw.slice(i, gtpos));
        return gtpos;
      }
      const named = matchAt(RX.tagfind, raw, i + 2);
      if (!named) {
        if (raw.slice(i, i + 3) === "</>") return i + 3;
        return this.parseBogusComment(i);
      }
      const tagname = named.m[1].toLowerCase();
      gtpos = raw.indexOf(">", named.end);
      this.endtag(tagname);
      return gtpos + 1;
    }
    const elem = found.m[1].toLowerCase();
    if (this.cdata !== null && elem !== this.cdata) {
      this.data(raw.slice(i, gtpos));
      return gtpos;
    }
    this.endtag(elem);
    this.cdata = null;
    this.interesting = null;
    return gtpos;
  }
}

export function htmlToText(html) {
  return new HtmlTextExtractor().feed(html);
}

function codePointPrefix(text, count) {
  if (text.length <= count) return text;
  return Array.from(text).slice(0, count).join("");
}

export function messagePreview(message) {
  let text = "";
  const body = isMultipart(message) ? getBody(message, ["plain"]) : message;
  if (body !== null && getContentDisposition(body) !== "attachment") {
    const bodyText = partText(body);
    text = getContentType(body) === "text/html" ? htmlToText(bodyText) : bodyText;
  }
  if (!text) {
    const htmlBody = isMultipart(message) ? getBody(message, ["html"]) : null;
    if (htmlBody !== null) text = htmlToText(partText(htmlBody));
  }
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return codePointPrefix(strip(text), 5000) || "No text preview available.";
}

function receivedAt(message) {
  const raw = rawHeader(message, "date");
  try {
    return localIsoWithOffset(parsedateToDatetime(raw === null ? "" : sanitize(raw)));
  } catch (exc) {
    if (exc instanceof ValueError || exc instanceof TypeError || exc instanceof RangeError) return "";
    throw exc;
  }
}

export function parseMessage(uid, rawMessage, metadata = "") {
  const message = parseBytes(Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage));
  const fromHeader = headerText(message, "from");
  const [senderName, senderEmail] = parseaddr(fromHeader ? fromHeader : "");
  const sender = senderName || senderEmail || "Unknown sender";
  const received = receivedAt(message);
  const subject = headerText(message, "subject");
  const meta = Buffer.isBuffer(metadata) ? metadata.toString("latin1") : String(metadata ?? "");
  return {
    uid,
    sender,
    sender_email: senderEmail,
    subject: subject ? subject : "(No subject)",
    received_at: received,
    preview: messagePreview(message),
    unread: !meta.includes("\\Seen"),
  };
}

const SIGN_IN_FAILED = "Could not sign in. Check the full email address and mailbox password.";
const UNREACHABLE = "Could not reach Hostinger mail. Check your internet connection.";
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEOUT",
]);

class MailCommandError extends Error {}

function isNetworkError(exc) {
  const code = String((exc && exc.code) || "");
  if (NETWORK_CODES.has(code)) return true;
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_OSSL)/.test(code)) return true;
  return Boolean(exc && exc.syscall);
}

function translateImapError(exc) {
  if (exc instanceof MailCommandError) return exc;
  if (exc && exc.authenticationFailed) return new Error(SIGN_IN_FAILED);
  if (isNetworkError(exc)) return new Error(UNREACHABLE);
  return new Error(SIGN_IN_FAILED);
}

function defaultClientFactory({ host, port, user, pass, timeout }) {
  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass, loginMethod: "LOGIN" },
    logger: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
  });
}

async function openClient(config, clientFactory) {
  const factory = clientFactory || defaultClientFactory;
  const client = factory({
    host: config.host || IMAP_HOST,
    port: pyInt(config.port || IMAP_PORT),
    user: config.email,
    pass: config.password,
    timeout: 20000,
  });
  if (client && typeof client.on === "function") client.on("error", () => {});
  return client;
}

async function closeClient(client) {
  if (!client) return;
  try {
    await client.logout();
  } catch {}
  try {
    if (typeof client.close === "function") client.close();
  } catch {}
}

async function openInbox(client, readOnly) {
  try {
    await client.mailboxOpen("INBOX", { readOnly });
  } catch (exc) {
    if (isNetworkError(exc)) throw exc;
    if ((exc && exc.responseStatus === "NO") || (exc && exc.message === "Failed to fetch folders")) {
      throw new MailCommandError("The Hostinger inbox could not be opened.");
    }
    throw exc;
  }
}

export async function fetchHostingerMail(config, clientFactory = null) {
  let client = null;
  try {
    let uidValues;
    const fetched = [];
    try {
      client = await openClient(config, clientFactory);
      await client.connect();
      await openInbox(client, true);
      const found = await client.search({ all: true }, { uid: true });
      if (!Array.isArray(found)) throw new MailCommandError("The Hostinger inbox could not be searched.");
      uidValues = found.map((value) => pyInt(value));
      const recent = uidValues.slice(-MESSAGE_LIMIT);
      if (recent.length) {
        try {
          for await (const item of client.fetch(recent.join(","), { uid: true, flags: true, source: { start: 0, maxLength: MESSAGE_BYTES } }, { uid: true })) {
            fetched.push(item);
          }
        } catch (exc) {
          if (isNetworkError(exc) || (exc && exc.responseStatus === "BAD")) throw exc;
          if (exc && exc.responseStatus === "NO") throw new MailCommandError("The Hostinger inbox messages could not be fetched.");
          throw exc;
        }
      }
    } catch (exc) {
      throw translateImapError(exc);
    }
    const recentUids = uidValues.slice(-MESSAGE_LIMIT);
    const byUid = new Map();
    for (const item of fetched) {
      if (!item || item.source === undefined || item.uid === undefined) continue;
      const uid = pyInt(item.uid);
      const flags = item.flags ? [...item.flags] : [];
      const metadata = `UID ${uid} FLAGS (${flags.join(" ")})`;
      byUid.set(uid, parseMessage(uid, Buffer.from(item.source), metadata));
    }
    const messages = [...recentUids].reverse().filter((uid) => byUid.has(uid)).map((uid) => byUid.get(uid));
    return [messages, uidValues.length ? Math.max(...uidValues) : 0];
  } finally {
    await closeClient(client);
  }
}

export async function setHostingerMessageRead(config, uid, read, clientFactory = null) {
  let client = null;
  try {
    client = await openClient(config, clientFactory);
    await client.connect();
    await openInbox(client, false);
    const flags = ["\\Seen"];
    const ok = read
      ? await client.messageFlagsAdd(String(uid), flags, { uid: true })
      : await client.messageFlagsRemove(String(uid), flags, { uid: true });
    if (!ok) throw new MailCommandError(`Hostinger could not mark this message as ${read ? "read" : "unread"}.`);
  } catch (exc) {
    throw translateImapError(exc);
  } finally {
    await closeClient(client);
  }
}

export async function markHostingerMessageRead(config, uid, clientFactory = null) {
  await setHostingerMessageRead(config, uid, true, clientFactory);
}

export async function markHostingerMessageUnread(config, uid, clientFactory = null) {
  await setHostingerMessageRead(config, uid, false, clientFactory);
}

export function protectPassword(password) {
  return protect(password);
}

export function unprotectPassword(encrypted) {
  return unprotect(encrypted);
}
