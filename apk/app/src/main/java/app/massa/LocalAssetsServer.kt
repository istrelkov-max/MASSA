package app.massa

import android.content.Context
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

/**
 * Крошечный HTTP-сервер внутри приложения.
 *
 * Зачем: GeckoView должен открывать интерфейс как обычный сайт, а не через file://.
 * Тогда работают localStorage, IndexedDB и service worker.
 *
 * Что делает:
 *  - отдаёт файлы из assets/web (наш интерфейс, всегда доступен офлайн);
 *  - запросы /api/... и /files/... пересылает на наш сервер (VPS),
 *    чтобы приложение работало с существующим бэкендом до перехода на Firebase.
 */
class LocalAssetsServer(
    private val context: Context,
    private val upstream: String = "https://50-114-115-15.sslip.io",
) {
    // фиксированный порт, чтобы адрес страницы не менялся между запусками:
    // от этого зависят localStorage, IndexedDB и кэш
    private val serverSocket = openSocket()
    private val pool = Executors.newFixedThreadPool(6)
    private val running = AtomicBoolean(false)

    val port: Int get() = serverSocket.localPort

    private fun openSocket(): ServerSocket {
        val address = InetAddress.getByName("127.0.0.1")

        for (candidate in intArrayOf(8737, 8738, 8739, 8740)) {
            try {
                return ServerSocket(candidate, 64, address)
            } catch (e: Exception) {
                // порт занят — пробуем следующий
            }
        }

        return ServerSocket(0, 64, address)
    }

    fun start() {
        if (!running.compareAndSet(false, true)) return

        Thread({
            while (running.get()) {
                val socket = try {
                    serverSocket.accept()
                } catch (e: Exception) {
                    break
                }

                pool.execute { handle(socket) }
            }
        }, "massa-assets").start()
    }

    fun stop() {
        running.set(false)
        try {
            serverSocket.close()
        } catch (e: Exception) {
            // уже закрыт
        }
        pool.shutdownNow()
    }

    private fun handle(socket: Socket) {
        try {
            socket.use { client ->
                val input = BufferedInputStream(client.getInputStream())
                val output = BufferedOutputStream(client.getOutputStream())

                val requestLine = readLine(input) ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return

                val method = parts[0]
                val path = parts[1]

                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isEmpty()) break
                    val idx = line.indexOf(':')
                    if (idx > 0) {
                        headers[line.substring(0, idx).trim().lowercase()] =
                            line.substring(idx + 1).trim()
                    }
                }

                val body = readBody(input, headers["content-length"]?.toIntOrNull() ?: 0)

                if (path.startsWith("/api/") || path.startsWith("/files/")) {
                    proxy(client, output, method, path, headers, body)
                } else {
                    serveAsset(output, path)
                }
            }
        } catch (e: Exception) {
            // соединение оборвалось — не страшно
        }
    }

    // --- статика из assets -------------------------------------------------

    private fun serveAsset(output: BufferedOutputStream, rawPath: String) {
        var path = rawPath.substringBefore('?')
        if (path == "/" || path.isEmpty()) path = "/index.html"

        val name = "web" + path

        val bytes = try {
            context.assets.open(name).use { it.readBytes() }
        } catch (e: Exception) {
            val notFound = "not found".toByteArray()
            output.write("HTTP/1.1 404 Not Found\r\n".toByteArray())
            output.write("Content-Type: text/plain; charset=utf-8\r\n".toByteArray())
            output.write("Content-Length: ${notFound.size}\r\n".toByteArray())
            output.write("Connection: close\r\n\r\n".toByteArray())
            output.write(notFound)
            output.flush()
            return
        }

        val type = mimeOf(name)

        output.write("HTTP/1.1 200 OK\r\n".toByteArray())
        output.write("Content-Type: $type\r\n".toByteArray())
        output.write("Content-Length: ${bytes.size}\r\n".toByteArray())
        output.write("Cache-Control: no-cache\r\n".toByteArray())
        output.write("Connection: close\r\n\r\n".toByteArray())
        output.write(bytes)
        output.flush()
    }

    private fun mimeOf(name: String): String = when {
        name.endsWith(".html") -> "text/html; charset=utf-8"
        name.endsWith(".css") -> "text/css; charset=utf-8"
        name.endsWith(".js") -> "application/javascript; charset=utf-8"
        name.endsWith(".json") -> "application/json; charset=utf-8"
        name.endsWith(".webmanifest") -> "application/manifest+json; charset=utf-8"
        name.endsWith(".png") -> "image/png"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".ico") -> "image/x-icon"
        name.endsWith(".md") -> "text/markdown; charset=utf-8"
        else -> "application/octet-stream"
    }

    // --- пересылка на VPS --------------------------------------------------

    private fun proxy(
        client: Socket,
        output: BufferedOutputStream,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: ByteArray?,
    ) {
        var connection: HttpsURLConnection? = null

        try {
            val url = URL(upstream + path)
            connection = url.openConnection() as HttpsURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 20000
            connection.readTimeout = 30000
            connection.instanceFollowRedirects = false

            connection.setRequestProperty("X-Forwarded-Proto", "https")
            connection.setRequestProperty("X-Forwarded-For", "127.0.0.1")

            headers["cookie"]?.let { connection.setRequestProperty("Cookie", it) }
            headers["content-type"]?.let { connection.setRequestProperty("Content-Type", it) }
            headers["accept"]?.let { connection.setRequestProperty("Accept", it) }

            if (body != null && body.isNotEmpty()) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }

            val status = connection.responseCode
            val stream: InputStream = if (status >= 400) {
                connection.errorStream ?: connection.inputStream
            } else {
                connection.inputStream
            }

            val payload = stream?.use { it.readBytes() } ?: ByteArray(0)

            val statusText = when (status) {
                200 -> "OK"
                201 -> "Created"
                204 -> "No Content"
                400 -> "Bad Request"
                401 -> "Unauthorized"
                403 -> "Forbidden"
                404 -> "Not Found"
                413 -> "Payload Too Large"
                429 -> "Too Many Requests"
                else -> "OK"
            }

            if (statusText == "OK" && status != 200) {
                // статус нестандартный — отдаём как есть
            }

            output.write("HTTP/1.1 $status $statusText\r\n".toByteArray())

            connection.headerFields.forEach { (key, values) ->
                val lower = key?.lowercase() ?: return@forEach
                if (lower == "set-cookie") {
                    values?.forEach { cookie ->
                        // на локальном канале Secure не нужен, иначе GeckoView
                        // не сохранит cookie на http://127.0.0.1
                        val fixed = cookie
                            .replace("; Secure", "")
                            .replace("; secure", "")
                        output.write("Set-Cookie: $fixed\r\n".toByteArray())
                    }
                    return@forEach
                }

                if (lower in listOf("content-type", "cache-control", "etag", "content-disposition")) {
                    values?.forEach { value ->
                        output.write("${key.trim()}: $value\r\n".toByteArray())
                    }
                }
            }

            output.write("Content-Length: ${payload.size}\r\n".toByteArray())
            output.write("Connection: close\r\n\r\n".toByteArray())
            output.write(payload)
            output.flush()
        } catch (e: Exception) {
            val message = "upstream error: ${e.message}".toByteArray()
            output.write("HTTP/1.1 502 Bad Gateway\r\n".toByteArray())
            output.write("Content-Type: text/plain; charset=utf-8\r\n".toByteArray())
            output.write("Content-Length: ${message.size}\r\n".toByteArray())
            output.write("Connection: close\r\n\r\n".toByteArray())
            output.write(message)
            output.flush()
        } finally {
            connection?.disconnect()
        }
    }

    // --- разбор запроса ----------------------------------------------------

    private fun readLine(input: InputStream): String? {
        val buffer = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buffer.isEmpty()) null else buffer.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) buffer.append(b.toChar())
            if (buffer.length > 8192) break
        }
        return buffer.toString()
    }

    private fun readBody(input: InputStream, length: Int): ByteArray? {
        if (length <= 0) return null
        val data = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(data, read, length - read)
            if (n <= 0) break
            read += n
        }
        return if (read == length) data else data.copyOf(read)
    }
}
