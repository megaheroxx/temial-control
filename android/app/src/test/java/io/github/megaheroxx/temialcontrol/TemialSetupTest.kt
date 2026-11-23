package io.github.megaheroxx.temialcontrol

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

private const val SERIAL = "2104118837"
private const val PAIRING = "abcdefghijklmnopqrstuvwxyz012345"
private const val QR = "1:$SERIAL:0:DE:$PAIRING"

private fun hex(value: String) = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }
private fun cipher(mode: Int) = Cipher.getInstance("AES/CTR/NoPadding")
    .apply { init(mode, SecretKeySpec(PAIRING.toByteArray(), "AES"), IvParameterSpec(ByteArray(16))) }

class TemialProtocolTest {
    @Test
    fun checksumMatchesFreemialTestVectors() {
        assertArrayEquals(bytes(212, 246, 230, 120), TemialProtocol.checksum(bytes(67, 84, 1, 0, 0)))
        assertArrayEquals(bytes(246, 38, 72, -26), TemialProtocol.checksum(bytes(67, 84, 3, 0, 0)))
        val config = byteArrayOf(67, 84) + TemialProtocol.wifiConfig("boiiii", 4, "the,Password!", "http://10.0.0.1:3000")
        assertArrayEquals(bytes(27, 19, 61, 36), TemialProtocol.checksum(config))
    }

    /** Bytes captured from @freemial/connect sending the same three messages with the same pairing code. */
    @Test
    fun encryptedFramesMatchReferenceLibrary() {
        val encryptor = cipher(Cipher.ENCRYPT_MODE)
        val sent = listOf(
            TemialProtocol.serialRequest(),
            TemialProtocol.networksRequest(),
            TemialProtocol.wifiConfig("Heimnetz", 4, "geheim123", "http://192.168.1.40:3010"),
        ).map { encryptor.update(TemialProtocol.frame(it)) }

        assertArrayEquals(hex("8377f5e12304f68aa1"), sent[0])
        assertArrayEquals(hex("726b96443590d4d005"), sent[1])
        assertArrayEquals(
            hex(
                "e68e356db05b4a5ca5fc442ef72c435dbfcd469b5b48763d10b46b22fe064b0534480fdd5aa135325a4f6e2a588335a2f98dc1" +
                    "9f2184d8f35649f1ff0c1c046c3e9694b36091f56fc11fdc365814523123e01213cf1f5ba00e964164447fd38e17548fbfa6" +
                    "92eec3bf128a855689a58894c5da759f53b229556a308207122eda3f08fd12d4043b3369d767e3bb6d714159b86b4034406b" +
                    "c5b3a468176faabd74e63ece8215d385e354cdc11dff",
            ),
            sent[2],
        )
    }

    @Test
    fun decodesReplies() {
        val serial = ByteArray(8).also { var v = SERIAL.toLong(); for (i in 0 until 8) { it[i] = v.toByte(); v = v shr 8 } }
        assertEquals(Reply.Serial(SERIAL), TemialProtocol.decode(reply(2, serial)))
        assertEquals(Reply.WifiCheck(true), TemialProtocol.decode(reply(6, bytes(1))))
        assertEquals(Reply.NotUnderstood, TemialProtocol.decode(reply(1, ByteArray(0))))
        assertEquals(Reply.Unknown(9), TemialProtocol.decode(reply(9, bytes(0))))

        val networks = TemialProtocol.decode(reply(4, networksPayload(WifiNetwork("Heimnetz", 4, 80), WifiNetwork("Nachbar", 3, 40))))
        assertEquals(Reply.Networks(listOf(WifiNetwork("Heimnetz", 4, 80), WifiNetwork("Nachbar", 3, 40))), networks)
    }

    @Test
    fun decodesSixteenBitLengthForLongNetworkLists() {
        val many = (1..9).map { WifiNetwork("Netz $it", 3, it) }
        val payload = networksPayload(*many.toTypedArray())
        assertTrue(payload.size > 255)
        assertEquals(Reply.Networks(many), TemialProtocol.decode(reply(4, payload)))
    }

    @Test
    fun parsesAndValidatesQrCode() {
        val qr = TemialQr.parse(" $QR ")
        assertEquals(SERIAL, qr.serialNumber)
        assertEquals("Temial-18837", qr.hotspot)
        for (bad in listOf("kein-qr", "1:$SERIAL:0:DE:kurz", "1::0:DE:$PAIRING")) {
            try {
                TemialQr.parse(bad)
                fail("$bad should be rejected")
            } catch (expected: SetupException) {
            }
        }
    }

    @Test
    fun validatesConfiguration() {
        TemialProtocol.validate("Heimnetz", "geheim123", "http://192.168.1.40:3010")
        for ((ssid, key, host) in listOf(
            Triple("Wohnzimmer-Ä", "geheim123", "http://192.168.1.40:3010"),
            Triple("", "geheim123", "http://192.168.1.40:3010"),
            Triple("Heimnetz", "x".repeat(64), "http://192.168.1.40:3010"),
            Triple("Heimnetz", "geheim123", "192.168.1.40:3010"),
            Triple("Heimnetz", "geheim123", "http://192.168.1.40:3010/pfad"),
        )) {
            try {
                TemialProtocol.validate(ssid, key, host)
                fail("$ssid/$host should be rejected")
            } catch (expected: SetupException) {
            }
        }
    }
}

/** End-to-end against a simulated hotspot speaking the same protocol. */
class TemialSetupFlowTest {
    private lateinit var server: ServerSocket
    private val received = mutableListOf<ByteArray>()
    private var disconnectAfterConfig = false
    private var splitReplies = false

    @Before
    fun startFakeTemial() {
        server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            server.accept().use { socket ->
                val decryptor = cipher(Cipher.DECRYPT_MODE)
                val encryptor = cipher(Cipher.ENCRYPT_MODE)
                val input = socket.getInputStream()
                val output = socket.getOutputStream()
                val chunk = ByteArray(1024)
                while (true) {
                    val read = input.read(chunk)
                    if (read < 0) break
                    val frame = decryptor.update(chunk, 0, read)
                    // Strip "CT" and the 4 checksum bytes.
                    val payload = frame.copyOfRange(2, frame.size - 4)
                    synchronized(received) { received += payload }
                    val answer = when (payload[0].toInt()) {
                        1 -> reply(2, ByteArray(8).also { var v = SERIAL.toLong(); for (i in 0 until 8) { it[i] = v.toByte(); v = v shr 8 } })
                        3 -> reply(4, networksPayload(WifiNetwork("Nachbar", 3, 40), WifiNetwork("Heimnetz", 4, 80)))
                        5 -> if (disconnectAfterConfig) break else reply(6, bytes(1))
                        else -> reply(0, ByteArray(0))
                    }
                    val encrypted = encryptor.update(answer)
                    if (splitReplies) {
                        output.write(encrypted, 0, 3); output.flush(); Thread.sleep(50)
                        output.write(encrypted, 3, encrypted.size - 3)
                    } else {
                        output.write(encrypted)
                    }
                    output.flush()
                }
            }
        }
    }

    @After
    fun stop() = server.close()

    private fun flow(steps: MutableList<String>): Pair<TemialSetupFlow, TemialLink> {
        val link = TemialLink(Socket(server.inetAddress, server.localPort), PAIRING)
        return TemialSetupFlow(link, TemialQr.parse(QR)) { steps += it } to link
    }

    @Test
    fun scanListsNetworksStrongestFirst() {
        splitReplies = true
        val steps = mutableListOf<String>()
        val (flow, link) = flow(steps)
        link.use { assertEquals(listOf("Heimnetz", "Nachbar"), flow.scan().map { it.ssid }) }
        assertTrue(steps.contains("Seriennummer $SERIAL passt zum QR-Code"))
    }

    @Test
    fun configureSendsCredentialsWithDetectedSecurityType() {
        val steps = mutableListOf<String>()
        val (flow, link) = flow(steps)
        link.use { assertTrue(flow.configure("Heimnetz", "geheim123", "http://192.168.1.40:3010", null)) }
        val config = synchronized(received) { received.last() }
        assertArrayEquals(TemialProtocol.wifiConfig("Heimnetz", 4, "geheim123", "http://192.168.1.40:3010"), config)
        assertTrue(steps.contains("Temial hat die Konfiguration bestätigt"))
    }

    @Test
    fun disconnectAfterSendingCountsAsUnconfirmedSuccess() {
        disconnectAfterConfig = true
        val (flow, link) = flow(mutableListOf())
        link.use { assertFalse(flow.configure("Heimnetz", "geheim123", "http://192.168.1.40:3010", null)) }
    }

    @Test
    fun hiddenNetworkNeedsSecurityType() {
        val (flow, link) = flow(mutableListOf())
        link.use {
            try {
                flow.configure("Versteckt", "geheim123", "http://192.168.1.40:3010", null)
                fail("hidden network without security type should fail")
            } catch (expected: SetupException) {
            }
        }
    }
}

private fun reply(type: Int, payload: ByteArray): ByteArray =
    bytes(0, 0, type, payload.size and 0xFF, payload.size shr 8) + payload

private fun networksPayload(vararg networks: WifiNetwork): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(0)
    for (network in networks) {
        val entry = ByteArray(36)
        val ssid = network.ssid.toByteArray()
        entry[1] = ssid.size.toByte()
        ssid.copyInto(entry, 2)
        entry[34] = network.securityType.toByte()
        entry[35] = network.signalStrength.toByte()
        out.write(entry)
    }
    return out.toByteArray()
}
