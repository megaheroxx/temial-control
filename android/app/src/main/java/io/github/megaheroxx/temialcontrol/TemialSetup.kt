package io.github.megaheroxx.temialcontrol

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.zip.CRC32
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

// First-time setup of a Temial over its own hotspot, ported from @freemial/connect
// (https://github.com/freemial/freemial-ts, packages/connect, AGPL-3.0-or-later).
// Plain JVM code without Android dependencies so it can be unit tested.

class SetupException(message: String) : Exception(message)

class ConnectionClosedException : IOException("The Temial closed the connection")

/** User-facing setup messages. Kept free of Android resources so the protocol stays unit-testable. */
interface SetupTexts {
    val qrFormat: String
    val pairingCode: String
    fun asciiOnly(field: String): String
    fun length(field: String, min: Int, max: Int): String
    val ssid: String
    val key: String
    val baseHost: String
    val baseHostFormat: String
    val incompleteReply: String
    val invalidSerial: String
    fun ssidNotVisible(ssid: String): String
    fun sending(ssid: String, baseHost: String): String
    val confirmed: String
    val received: String
    val switching: String
    fun serialMatches(serial: String): String
    fun serialMismatch(serial: String): String
    val scanning: String
    fun networksFound(count: Int): String
    val notUnderstood: String
}

object EnglishSetupTexts : SetupTexts {
    override val qrFormat = "The QR code does not have the expected format (5 parts separated by colons)"
    override val pairingCode = "The pairing code in the QR code is invalid. Please show the QR code again."
    override fun asciiOnly(field: String) = "$field contains umlauts or special characters. The protocol only transfers ASCII correctly."
    override fun length(field: String, min: Int, max: Int) = "$field must be $min–$max characters long"
    override val ssid = "Wi-Fi name"
    override val key = "Wi-Fi password"
    override val baseHost = "Server address"
    override val baseHostFormat = "The server address must look like http://192.168.1.40:3010 (without a path)"
    override val incompleteReply = "Incomplete answer from the Temial"
    override val invalidSerial = "Invalid serial number from the Temial"
    override fun ssidNotVisible(ssid: String) = "The Temial cannot see the Wi-Fi “$ssid”. For hidden networks, choose the security type."
    override fun sending(ssid: String, baseHost: String) = "Sending Wi-Fi “$ssid” and server $baseHost …"
    override val confirmed = "The Temial confirmed the configuration"
    override val received = "The Temial received the configuration"
    override val switching = "Configuration sent, the Temial is switching to your Wi-Fi"
    override fun serialMatches(serial: String) = "Serial number $serial matches the QR code"
    override fun serialMismatch(serial: String) = "Warning: the device reports serial number $serial"
    override val scanning = "The Temial is searching for Wi-Fi networks (up to 30 seconds) …"
    override fun networksFound(count: Int) = "$count Wi-Fi network(s) found"
    override val notUnderstood = "The Temial did not understand the request. Please show the QR code again."
}

object GermanSetupTexts : SetupTexts {
    override val qrFormat = "QR-Code hat nicht das erwartete Format (5 Teile, getrennt durch Doppelpunkte)"
    override val pairingCode = "Pairing-Code im QR-Code ist ungültig. QR-Code bitte neu anzeigen lassen."
    override fun asciiOnly(field: String) = "$field enthält Umlaute oder Sonderzeichen. Das Protokoll überträgt nur ASCII korrekt."
    override fun length(field: String, min: Int, max: Int) = "$field muss $min–$max Zeichen lang sein"
    override val ssid = "WLAN-Name"
    override val key = "WLAN-Passwort"
    override val baseHost = "Server-Adresse"
    override val baseHostFormat = "Server-Adresse muss wie http://192.168.1.40:3010 aussehen (ohne Pfad)"
    override val incompleteReply = "Unvollständige Antwort der Temial"
    override val invalidSerial = "Ungültige Seriennummer von der Temial"
    override fun ssidNotVisible(ssid: String) = "Die Temial sieht das WLAN „$ssid“ nicht. Bei versteckten Netzen den Sicherheitstyp wählen."
    override fun sending(ssid: String, baseHost: String) = "Sende WLAN „$ssid“ und Server $baseHost …"
    override val confirmed = "Temial hat die Konfiguration bestätigt"
    override val received = "Temial hat die Konfiguration empfangen"
    override val switching = "Konfiguration gesendet, Temial wechselt ins WLAN"
    override fun serialMatches(serial: String) = "Seriennummer $serial passt zum QR-Code"
    override fun serialMismatch(serial: String) = "Achtung: Gerät meldet Seriennummer $serial"
    override val scanning = "Temial sucht WLANs (bis zu 30 Sekunden) …"
    override fun networksFound(count: Int) = "$count WLAN(s) gefunden"
    override val notUnderstood = "Die Temial hat die Anfrage nicht verstanden. QR-Code neu anzeigen lassen."
}

/** German for German phones, English otherwise. */
fun setupTexts(language: String): SetupTexts = if (language == "de") GermanSetupTexts else EnglishSetupTexts

data class TemialQr(val serialNumber: String, val pairingCode: String) {
    /** Name of the open Wi-Fi network the device opens while showing the QR code. */
    val hotspot: String get() = "Temial-${serialNumber.takeLast(5)}"

    companion object {
        fun parse(raw: String, texts: SetupTexts = EnglishSetupTexts): TemialQr {
            val parts = raw.trim().split(":")
            if (parts.size != 5 || parts.any { it.isEmpty() }) {
                throw SetupException(texts.qrFormat)
            }
            if (parts[4].toByteArray(Charsets.UTF_8).size != 32) {
                throw SetupException(texts.pairingCode)
            }
            return TemialQr(serialNumber = parts[1], pairingCode = parts[4])
        }
    }
}

data class WifiNetwork(val ssid: String, val securityType: Int, val signalStrength: Int)

sealed interface Reply {
    data class Serial(val serialNumber: String) : Reply
    data class Networks(val networks: List<WifiNetwork>) : Reply
    data class WifiCheck(val ok: Boolean) : Reply
    data object NotUnderstood : Reply
    data class Unknown(val type: Int) : Reply
}

object TemialProtocol {
    const val HOST = "192.168.1.1"
    const val PORT = 4478
    val SECURITY_TYPES = listOf("NONE", "WEP", "WPA", "WPA2", "WPA2MIXED")

    private const val SSID_MAX = 32
    private const val KEY_MAX = 63
    private const val BASE_HOST_MAX = 64
    private val PRINTABLE_ASCII = Regex("^[\\x20-\\x7e]*$")
    private val BASE_HOST = Regex("^https?://[^/\\s]+$")

    fun serialRequest() = byteArrayOf(1, 0, 0)

    fun networksRequest() = byteArrayOf(3, 0, 0)

    fun wifiConfig(ssid: String, securityType: Int, key: String, baseHost: String): ByteArray =
        ByteArrayOutputStream().apply {
            write(5)
            write(0xA4)
            write(0)
            write(field(ssid, SSID_MAX))
            write(securityType)
            write(field(key, KEY_MAX))
            write(0)
            write(field(baseHost, BASE_HOST_MAX))
        }.toByteArray()

    /** Same checks as the server: the library writes the character count as length byte, so only ASCII works. */
    fun validate(ssid: String, key: String, baseHost: String, texts: SetupTexts = EnglishSetupTexts) {
        fun text(value: String, name: String, min: Int, max: Int) {
            if (!PRINTABLE_ASCII.matches(value)) {
                throw SetupException(texts.asciiOnly(name))
            }
            if (value.length !in min..max) throw SetupException(texts.length(name, min, max))
        }
        text(ssid, texts.ssid, 1, SSID_MAX)
        text(key, texts.key, 0, KEY_MAX)
        text(baseHost, texts.baseHost, 1, BASE_HOST_MAX)
        if (!BASE_HOST.matches(baseHost)) {
            throw SetupException(texts.baseHostFormat)
        }
    }

    private fun field(value: String, max: Int): ByteArray {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= max) { "Text is longer than $max bytes" }
        return ByteArray(max + 1).also {
            it[0] = value.length.toByte()
            bytes.copyInto(it, 1)
        }
    }

    /** "CT" header + payload + checksum, before encryption. */
    fun frame(payload: ByteArray): ByteArray {
        val body = byteArrayOf('C'.code.toByte(), 'T'.code.toByte()) + payload
        return body + checksum(body)
    }

    /**
     * The device's CRC variant: the message is read in 4-byte words (each reversed, padded with 0xFF),
     * every byte bit-reversed, run through standard CRC-32, and the result bit-reversed (little endian).
     */
    fun checksum(data: ByteArray): ByteArray {
        val length = (data.size + 3) / 4 * 4
        val words = ByteArray(length)
        var k = 0
        for (chunk in 0 until length step 4) {
            for (j in 3 downTo 0) {
                val index = chunk + j
                words[k++] = if (index < data.size) data[index] else 0xFF.toByte()
            }
        }
        val reversed = ByteArray(length) { (Integer.reverse(words[it].toInt() and 0xFF) ushr 24).toByte() }
        val value = Integer.reverse(CRC32().apply { update(reversed) }.value.toInt())
        return byteArrayOf(value.toByte(), (value shr 8).toByte(), (value shr 16).toByte(), (value shr 24).toByte())
    }

    /** Total length of a decrypted reply (5 header bytes + payload), or null if the header is incomplete. */
    fun expectedLength(plain: ByteArray): Int? =
        if (plain.size < 5) null else 5 + (plain[3].toInt() and 0xFF) + ((plain[4].toInt() and 0xFF) shl 8)

    fun decode(plain: ByteArray, texts: SetupTexts = EnglishSetupTexts): Reply {
        val length = expectedLength(plain) ?: throw SetupException(texts.incompleteReply)
        val payload = plain.copyOfRange(5, length)
        return when (val type = plain[2].toInt() and 0xFF) {
            0, 1 -> Reply.NotUnderstood
            2 -> Reply.Serial(littleEndianLong(payload, texts).toString())
            4 -> Reply.Networks(networks(payload))
            6 -> Reply.WifiCheck(payload.isNotEmpty() && payload[0].toInt() == 1)
            else -> Reply.Unknown(type)
        }
    }

    private fun littleEndianLong(bytes: ByteArray, texts: SetupTexts): Long {
        if (bytes.size < 8) throw SetupException(texts.invalidSerial)
        var value = 0L
        for (i in 7 downTo 0) value = (value shl 8) or (bytes[i].toLong() and 0xFF)
        return value
    }

    private fun networks(payload: ByteArray): List<WifiNetwork> {
        val list = mutableListOf<WifiNetwork>()
        // Entries of 36 bytes start at index 1: [i+1] SSID length, [i+2..] SSID, [i+34] security, [i+35] signal.
        var i = 1
        while (i + 35 < payload.size) {
            val length = payload[i + 1].toInt() and 0xFF
            val ssid = String(payload, i + 2, length.coerceAtMost(32), Charsets.UTF_8)
            list += WifiNetwork(ssid, payload[i + 34].toInt() and 0xFF, payload[i + 35].toInt() and 0xFF)
            i += 36
        }
        return list
    }
}

/** An encrypted connection to the device hotspot. The cipher streams must stay alive for the whole connection. */
class TemialLink(
    private val socket: Socket,
    pairingCode: String,
    private val texts: SetupTexts = EnglishSetupTexts,
) : Closeable {
    // Not named key/iv: inside Cipher.apply {} those would resolve to Cipher's own properties.
    private val keySpec = SecretKeySpec(pairingCode.toByteArray(Charsets.UTF_8), "AES")
    private val ivSpec = IvParameterSpec(ByteArray(16))
    private val encryptor = Cipher.getInstance("AES/CTR/NoPadding").apply { init(Cipher.ENCRYPT_MODE, keySpec, ivSpec) }
    private val decryptor = Cipher.getInstance("AES/CTR/NoPadding").apply { init(Cipher.DECRYPT_MODE, keySpec, ivSpec) }

    fun send(payload: ByteArray) {
        socket.getOutputStream().apply {
            write(encryptor.update(TemialProtocol.frame(payload)))
            flush()
        }
    }

    /**
     * Reads one reply. Like the reference library, bytes received together form one reply; trailing bytes
     * (e.g. a checksum) are decrypted to keep the cipher in sync and then dropped.
     */
    fun receive(timeoutMs: Int): Reply {
        socket.soTimeout = timeoutMs
        val input = socket.getInputStream()
        val plain = ByteArrayOutputStream()
        val chunk = ByteArray(2048)
        while (true) {
            val read = input.read(chunk)
            if (read < 0) throw ConnectionClosedException()
            plain.write(decryptor.update(chunk, 0, read) ?: ByteArray(0))
            val bytes = plain.toByteArray()
            val needed = TemialProtocol.expectedLength(bytes) ?: continue
            if (bytes.size >= needed) return TemialProtocol.decode(bytes, texts)
        }
    }

    override fun close() = socket.close()
}

/** Serial check → Wi-Fi scan → send configuration, following the Freemial CLI. */
class TemialSetupFlow(
    private val link: TemialLink,
    private val qr: TemialQr,
    private val texts: SetupTexts = EnglishSetupTexts,
    private val step: (String) -> Unit,
) {
    fun scan(): List<WifiNetwork> {
        checkSerial()
        return networks()
    }

    /** Returns true if the device confirmed the configuration, false if it switched networks right away. */
    fun configure(ssid: String, key: String, baseHost: String, manualSecurityType: Int?): Boolean {
        TemialProtocol.validate(ssid, key, baseHost, texts)
        checkSerial()
        val visible = networks().firstOrNull { it.ssid == ssid }
        val securityType = visible?.securityType ?: manualSecurityType
            ?: throw SetupException(texts.ssidNotVisible(ssid))

        step(texts.sending(ssid, baseHost))
        link.send(TemialProtocol.wifiConfig(ssid, securityType, key, baseHost))
        return try {
            val reply = await<Reply.WifiCheck>(CONFIRM_TIMEOUT_MS)
            step(if (reply.ok) texts.confirmed else texts.received)
            reply.ok
        } catch (e: SocketTimeoutException) {
            step(texts.switching)
            false
        } catch (e: ConnectionClosedException) {
            // The device often drops its hotspot right away to join the new Wi-Fi.
            step(texts.switching)
            false
        }
    }

    private fun checkSerial() {
        link.send(TemialProtocol.serialRequest())
        val serial = await<Reply.Serial>(SERIAL_TIMEOUT_MS).serialNumber
        step(
            if (serial == qr.serialNumber) texts.serialMatches(serial) else texts.serialMismatch(serial),
        )
    }

    private fun networks(): List<WifiNetwork> {
        step(texts.scanning)
        link.send(TemialProtocol.networksRequest())
        val networks = await<Reply.Networks>(SCAN_TIMEOUT_MS).networks
            .filter { it.ssid.isNotBlank() }
            .sortedByDescending { it.signalStrength }
        step(texts.networksFound(networks.size))
        return networks
    }

    private inline fun <reified T : Reply> await(timeoutMs: Int): T {
        while (true) {
            when (val reply = link.receive(timeoutMs)) {
                is T -> return reply
                Reply.NotUnderstood ->
                    throw SetupException(texts.notUnderstood)
                else -> Unit
            }
        }
    }

    companion object {
        const val SERIAL_TIMEOUT_MS = 10_000
        const val SCAN_TIMEOUT_MS = 30_000
        const val CONFIRM_TIMEOUT_MS = 30_000
    }
}
