package expo.modules.t3deviceruntime

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

private const val UBUNTU_RELEASE = "https://cdimage.ubuntu.com/ubuntu-base/releases/26.04.1/release/"
private const val CLAUDE_KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc"
private const val CLAUDE_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
private const val CONNECT_ATTEMPTS = 3
private const val TERMINATE_GRACE_SECONDS = 5L
internal const val TAG = "T3DeviceRuntime"
const val GUEST_PATH = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// Kotlin has no octal literals: 0777, 0600, 0700 and 0755.
private const val PERMISSION_BITS = 0x1FF
private const val OWNER_READ_WRITE = 0x180
private const val OWNER_ALL = 0x1C0
private const val EXECUTABLE = 0x1ED

class RuntimeCancelled : IOException("Cancelled")

/** A command running in the guest. `process` is proot itself. */
class GuestProcess(val process: Process, private val pidFile: File) {
  /**
   * proot ignores SIGTERM and SIGQUIT, and Android's destroyForcibly() only sends SIGTERM.
   * The guest's own process does take signals, and once it exits proot (--kill-on-exit)
   * kills any other guest process and exits too.
   */
  fun terminate() {
    val pids = runCatching { pidFile.readText().trim().split(' ').map { it.toInt() } }.getOrNull()
    val guestPid = pids?.getOrNull(0)
    val prootPid = pids?.getOrNull(1)
    if (guestPid != null) runCatching { Os.kill(guestPid, OsConstants.SIGTERM) }
    Thread({
      if (!process.waitFor(TERMINATE_GRACE_SECONDS, TimeUnit.SECONDS)) {
        Log.w(TAG, "Guest $guestPid outlived SIGTERM; killing it and proot $prootPid")
        for (pid in listOfNotNull(guestPid, prootPid)) runCatching { Os.kill(pid, OsConstants.SIGKILL) }
      }
    }, "t3-guest-terminate").start()
  }

  internal fun cleanUp() {
    pidFile.delete()
  }
}

/**
 * Ubuntu's name for the architecture of the installed native library directory
 * (lib/arm64 or lib/x86_64), or null where no proot is bundled. x86_64 is for emulators.
 */
fun ubuntuArchitecture(libraryDirectory: String): String? = when (libraryDirectory) {
  "arm64" -> "arm64"
  "x86_64" -> "amd64"
  else -> null
}

/**
 * An Ubuntu userland in app storage, run through proot from the APK's native library
 * directory. Apps targeting Android 10+ can't execute files they wrote, but they can map
 * them: proot runs every guest program through its loader, which maps the program instead.
 */
class DeviceRuntime(private val context: Context, private val log: (String) -> Unit) {
  private val libDir = File(context.applicationInfo.nativeLibraryDir)
  val proot = File(libDir, "libproot.so")
  private val loader = File(libDir, "libproot-loader.so")
  val home = File(context.filesDir, "device-runtime")
  val rootfs = File(home, "ubuntu")
  private val installedMarker = File(home, "ubuntu.installed")
  private val architecture = ubuntuArchitecture(libDir.name)
  private val ubuntuTarball = "ubuntu-base-26.04.1-base-$architecture.tar.gz"
  val supported: Boolean
    get() = architecture != null && proot.isFile
  private val fakeProc = File(home, "proc")
  private val prootTmp = File(context.cacheDir, "proot")

  @Volatile private var guest: GuestProcess? = null
  @Volatile private var cancelled = false

  val ubuntuInstalled: Boolean
    get() = installedMarker.isFile && installedMarker.readText().trim() == ubuntuTarball

  fun cancel() {
    cancelled = true
    guest?.terminate()
  }

  private fun checkCancelled() {
    if (cancelled) throw RuntimeCancelled()
  }

  /** Downloads Ubuntu base, checks it against the release's SHA256SUMS and extracts it. */
  fun installUbuntu() {
    if (ubuntuInstalled) {
      log("Ubuntu base is already extracted.")
      return
    }
    val sums = fetchText(UBUNTU_RELEASE + "SHA256SUMS")
    val expected = Regex("^([0-9a-f]{64}) [ *]" + Regex.escape(ubuntuTarball) + "$", RegexOption.MULTILINE)
      .find(sums)?.groupValues?.get(1)
      ?: throw IOException("SHA256SUMS doesn't list $ubuntuTarball")
    home.mkdirs()
    val tarball = File(context.cacheDir, ubuntuTarball)
    log("Downloading $ubuntuTarball")
    val actual = download(UBUNTU_RELEASE + ubuntuTarball, tarball)
    if (actual != expected) {
      tarball.delete()
      throw IOException("$ubuntuTarball has SHA-256 $actual, expected $expected")
    }
    val staging = File(home, "ubuntu.staging")
    deleteTree(staging)
    deleteTree(rootfs)
    installedMarker.delete()
    staging.mkdirs()
    log("Extracting $ubuntuTarball")
    tarball.inputStream().buffered(1 shl 16).use { extractTar(GZIPInputStream(it, 1 shl 16), staging) }
    tarball.delete()
    if (!staging.renameTo(rootfs)) throw IOException("Couldn't move the extracted Ubuntu into place")
    installedMarker.writeText(ubuntuTarball)
  }

  /** Puts Anthropic's apt signing key in the guest once its fingerprint matches the published one. */
  fun installClaudeKey() {
    val armored = fetchText(CLAUDE_KEY_URL)
    val fingerprint = openPgpFingerprint(armored)
    if (fingerprint != CLAUDE_KEY_FINGERPRINT) {
      throw IOException("Claude Code's signing key has fingerprint $fingerprint, expected $CLAUDE_KEY_FINGERPRINT")
    }
    val keyrings = File(rootfs, "etc/apt/keyrings").apply { mkdirs() }
    File(keyrings, "claude-code.asc").writeText(armored)
    log("Claude Code signing key verified: $fingerprint")
  }

  /** The server names its environment after PRETTY_HOSTNAME. */
  fun writeMachineInfo(deviceName: String) {
    val name = deviceName.filterNot { it == '"' || it == '\\' || it.isISOControl() }
    replaceFile(File(rootfs, "etc/machine-info"), "PRETTY_HOSTNAME=\"$name\"\n")
  }

  /** Where the guest's BROWSER leaves a URL for the app to open. */
  val openUrlFile: File
    get() = File(rootfs, "tmp/.t3-open-url")

  fun writeOpenUrlCommand() {
    val command = File(rootfs, "usr/local/bin/t3-open-url")
    replaceFile(command, "#!/bin/sh\nprintf '%s\\n' \"$1\" > /tmp/.t3-open-url.$$ && mv /tmp/.t3-open-url.$$ /tmp/.t3-open-url\n")
    Os.chmod(command.path, EXECUTABLE)
  }

  /** Android has no resolv.conf, and some /proc files are closed to apps; the guest needs both. */
  private fun writeGuestConfig() {
    val dns = runCatching {
      val connectivity = context.getSystemService(ConnectivityManager::class.java)
      connectivity.getLinkProperties(connectivity.activeNetwork)?.dnsServers.orEmpty()
        .mapNotNull { it.hostAddress }
    }.getOrDefault(emptyList())
    val servers = (dns + listOf("1.1.1.1", "8.8.8.8")).distinct().take(3)
    // Short timeouts with retries: the first server can be one a mobile network won't answer.
    replaceFile(
      File(rootfs, "etc/resolv.conf"),
      servers.joinToString("") { "nameserver $it\n" } + "options timeout:2 attempts:3\n",
    )
    val hosts = File(rootfs, "etc/hosts")
    if (!hosts.isFile || hosts.length() == 0L) {
      replaceFile(hosts, "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n")
    }
    fakeProc.mkdirs()
    val sdcard = File(rootfs, "sdcard").toPath()
    if (!Files.exists(sdcard, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
      Os.symlink("/storage/emulated/0", sdcard.toString())
    }
  }

  // Each entry is a file proot-distro also replaces when Android won't let apps read it.
  private fun fakeProcBinds(): List<String> {
    val cpus = Runtime.getRuntime().availableProcessors()
    val uptime = SystemClock.elapsedRealtime() / 1000.0
    val fakes = mapOf(
      "loadavg" to "0.12 0.07 0.02 2/165 765\n",
      "stat" to buildString {
        append("cpu  1957 0 2877 93280 262 342 254 87 0 0\n")
        for (cpu in 0 until cpus) append("cpu$cpu 31 0 226 12027 82 10 4 9 0 0\n")
        append("intr 0\nctxt 140223\nbtime 1680020856\nprocesses 772\nprocs_running 2\nprocs_blocked 0\n")
      },
      "uptime" to "%.2f %.2f\n".format(uptime, uptime * cpus),
      "version" to "Linux version ${System.getProperty("os.version")} (proot) #1 SMP PREEMPT\n",
      "vmstat" to "nr_free_pages 136000\nnr_inactive_anon 0\nnr_active_anon 0\npgpgin 0\npgpgout 0\n",
      "sys/kernel/cap_last_cap" to "40\n",
      "sys/fs/inotify/max_user_watches" to "524288\n",
    )
    return fakes.flatMap { (name, content) ->
      val real = File("/proc/$name")
      if (runCatching { real.readBytes() }.isSuccess) return@flatMap emptyList()
      val fake = File(fakeProc, name)
      fake.parentFile?.mkdirs()
      fake.writeText(content)
      listOf("-b", "${fake.path}:/proc/$name")
    }
  }

  private fun prootCommand(guestCommand: List<String>, environment: Map<String, String>): List<String> {
    val shm = File(rootfs, "tmp").apply { mkdirs() }
    val guestEnvironment = mapOf(
      "HOME" to "/root",
      "PATH" to GUEST_PATH,
      "TERM" to "xterm-256color",
      "LANG" to "C.UTF-8",
      "TMPDIR" to "/tmp",
    ) + environment
    return buildList {
      add(proot.path)
      addAll(listOf("--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "--root-id"))
      addAll(listOf("--rootfs=${rootfs.path}", "--cwd=/root"))
      for (bind in listOf(
        "/dev", "/proc", "/sys",
        "/dev/urandom:/dev/random",
        "/proc/self/fd:/dev/fd",
        "/proc/self/fd/0:/dev/stdin",
        "/proc/self/fd/1:/dev/stdout",
        "/proc/self/fd/2:/dev/stderr",
        "${shm.path}:/dev/shm",
        // Phone storage, with /sdcard a symlink into it. proot drops a bind whose source it
        // can't read at start, as /storage/emulated/0 before All files access; /storage it
        // can, so a later grant works without a restart.
        "/storage",
      )) add("--bind=$bind")
      addAll(fakeProcBinds())
      // A clean environment, so nothing of the app's Android one reaches glibc programs.
      add("/usr/bin/env")
      add("-i")
      guestEnvironment.forEach { (key, value) -> add("$key=$value") }
      addAll(guestCommand)
    }
  }

  /** Starts a command in the guest with stderr merged into stdout. */
  fun start(guestCommand: List<String>, environment: Map<String, String> = emptyMap()): GuestProcess {
    checkCancelled()
    writeGuestConfig()
    prootTmp.mkdirs()
    val token = "${System.nanoTime()}"
    // Records the guest's pid, which exec keeps, and its parent's, proot's. The pids are
    // real ones: proot doesn't namespace them.
    val command = listOf("/bin/sh", "-c", "echo \$\$ \$PPID > /tmp/.t3-pids.$token && exec \"\$@\"", "sh") + guestCommand
    val builder = ProcessBuilder(prootCommand(command, environment))
      .directory(home)
      .redirectErrorStream(true)
    builder.environment().apply {
      put("PROOT_LOADER", loader.path)
      put("PROOT_TMP_DIR", prootTmp.path)
      remove("LD_PRELOAD")
    }
    return GuestProcess(builder.start(), File(rootfs, "tmp/.t3-pids.$token"))
  }

  /** Runs a command in the guest, passing each output line on, and returns its exit status. */
  fun run(
    guestCommand: List<String>,
    stdin: String? = null,
    environment: Map<String, String> = emptyMap(),
    onLine: (String) -> Unit = log,
  ): Int {
    val started = start(guestCommand, environment)
    guest = started
    try {
      started.process.outputStream.use { input -> stdin?.let { input.write(it.toByteArray()) } }
      started.process.inputStream.bufferedReader().useLines { lines -> lines.forEach(onLine) }
      return started.process.waitFor()
    } catch (error: IOException) {
      // Cancelling closes the output under the reader.
      checkCancelled()
      throw error
    } finally {
      guest = null
      started.cleanUp()
      checkCancelled()
    }
  }

  /** Runs a command in the guest and returns its exit status and output. */
  fun capture(guestCommand: List<String>, stdin: String? = null): Pair<Int, String> {
    val output = StringBuilder()
    val code = run(guestCommand, stdin) { output.append(it).append('\n') }
    return code to output.toString()
  }

  /** Deletes Ubuntu and everything installed in it, including the server's data. */
  fun remove() {
    deleteTree(home)
    deleteTree(prootTmp)
  }

  // Phones drop DNS and connections while they switch networks, so connecting retries.
  private fun open(url: String, attempt: Int = 1): HttpURLConnection {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    val code = try {
      connection.responseCode
    } catch (error: IOException) {
      connection.disconnect()
      if (attempt >= CONNECT_ATTEMPTS) throw error
      checkCancelled()
      Thread.sleep(attempt * 2_000L)
      return open(url, attempt + 1)
    }
    if (code != HttpURLConnection.HTTP_OK) {
      connection.disconnect()
      throw IOException("$url answered HTTP $code")
    }
    return connection
  }

  private fun fetchText(url: String): String {
    val connection = open(url)
    try {
      return connection.inputStream.bufferedReader().readText()
    } finally {
      connection.disconnect()
    }
  }

  /** Streams url to target and returns its SHA-256 in hex. */
  private fun download(url: String, target: File): String {
    val connection = open(url)
    val digest = MessageDigest.getInstance("SHA-256")
    val total = connection.contentLengthLong
    var done = 0L
    var reported = 0L
    try {
      connection.inputStream.use { input ->
        target.outputStream().use { output ->
          val buffer = ByteArray(1 shl 16)
          while (true) {
            checkCancelled()
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)
            done += read
            if (done - reported >= 5_000_000) {
              reported = done
              log("Downloaded ${megabytes(done)} of ${megabytes(total)}")
            }
          }
        }
      }
    } finally {
      connection.disconnect()
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  /**
   * Extracts ustar and GNU tar. Hard links become symlinks: Android refuses link() in app
   * storage, and copies would multiply Ubuntu's multi-call coreutils binary a hundredfold.
   */
  private fun extractTar(input: InputStream, target: File) {
    val header = ByteArray(512)
    var longName: String? = null
    var longLink: String? = null
    var pax = emptyMap<String, String>()
    var entries = 0
    while (true) {
      checkCancelled()
      if (!input.readBlock(header) || header.all { it.toInt() == 0 }) break
      val type = header[156].toInt().toChar()
      val size = header.octal(124, 12)
      when (type) {
        'L' -> { longName = input.readEntry(size).cString(); continue }
        'K' -> { longLink = input.readEntry(size).cString(); continue }
        'x' -> { pax = parsePax(input.readEntry(size)); continue }
        'g' -> { input.copyEntry(null, size); continue }
      }
      val ustar = String(header, 257, 5, Charsets.US_ASCII) == "ustar"
      val prefix = if (ustar) header.field(345, 155) else ""
      val name = pax["path"] ?: longName ?: listOf(prefix, header.field(0, 100)).filter { it.isNotEmpty() }.joinToString("/")
      val link = pax["linkpath"] ?: longLink ?: header.field(157, 100)
      longName = null
      longLink = null
      pax = emptyMap()
      val mode = header.octal(100, 8).toInt() and PERMISSION_BITS
      val relative = name.split('/').filter { it.isNotEmpty() && it != "." }
      if (relative.any { it == ".." }) throw IOException("Refusing tar entry outside the root: $name")
      if (relative.isEmpty()) {
        input.copyEntry(null, size)
        continue
      }
      val file = File(target, relative.joinToString("/"))
      file.parentFile?.mkdirs()
      when (type) {
        '0', '\u0000', '7' -> {
          Files.deleteIfExists(file.toPath())
          file.outputStream().buffered(1 shl 16).use { input.copyEntry(it, size) }
          Os.chmod(file.path, mode or OWNER_READ_WRITE)
        }
        '5' -> {
          file.mkdirs()
          Os.chmod(file.path, mode or OWNER_ALL)
          input.copyEntry(null, size)
        }
        '2' -> {
          Files.deleteIfExists(file.toPath())
          Os.symlink(link, file.path)
          input.copyEntry(null, size)
        }
        '1' -> {
          Files.deleteIfExists(file.toPath())
          Os.symlink("/" + link.removePrefix("./").trimStart('/'), file.path)
          input.copyEntry(null, size)
        }
        // Device nodes and FIFOs: /dev comes from Android through a bind.
        else -> input.copyEntry(null, size)
      }
      entries++
      if (entries % 1000 == 0) log("Extracted $entries entries")
    }
    log("Extracted $entries entries")
  }

  private fun replaceFile(file: File, content: String) {
    Files.deleteIfExists(file.toPath())
    file.parentFile?.mkdirs()
    file.writeText(content)
  }
}

/** The fingerprint of the first public key in an ASCII-armored OpenPGP block (RFC 9580). */
fun openPgpFingerprint(armored: String): String {
  val body = armored.lineSequence()
    .dropWhile { !it.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") }
    .drop(1)
    .dropWhile { it.isNotBlank() }
    .takeWhile { !it.startsWith("-----END") }
    // The armor's CRC-24 line.
    .filterNot { it.startsWith("=") && it.length == 5 }
    .joinToString("")
  val data = Base64.decode(body, Base64.DEFAULT)
  val first = data[0].toInt() and 0xFF
  require(first and 0x80 != 0) { "Not an OpenPGP packet" }
  val tag: Int
  val length: Int
  val offset: Int
  if (first and 0x40 != 0) {
    tag = first and 0x3F
    val l0 = data[1].toInt() and 0xFF
    when {
      l0 < 192 -> { length = l0; offset = 2 }
      l0 < 224 -> { length = ((l0 - 192) shl 8) + (data[2].toInt() and 0xFF) + 192; offset = 3 }
      l0 == 255 -> { length = data.int32(2); offset = 6 }
      else -> throw IllegalArgumentException("Partial-length key packet")
    }
  } else {
    tag = (first shr 2) and 0x0F
    when (first and 0x03) {
      0 -> { length = data[1].toInt() and 0xFF; offset = 2 }
      1 -> { length = ((data[1].toInt() and 0xFF) shl 8) or (data[2].toInt() and 0xFF); offset = 3 }
      2 -> { length = data.int32(1); offset = 5 }
      else -> throw IllegalArgumentException("Indeterminate-length key packet")
    }
  }
  require(tag == 6) { "The first packet isn't a public key" }
  val key = data.copyOfRange(offset, offset + length)
  val digest = when (key[0].toInt()) {
    4 -> MessageDigest.getInstance("SHA-1").apply {
      update(0x99.toByte())
      update((length shr 8).toByte())
      update(length.toByte())
    }
    6 -> MessageDigest.getInstance("SHA-256").apply {
      update(0x9B.toByte())
      update(byteArrayOf((length shr 24).toByte(), (length shr 16).toByte(), (length shr 8).toByte(), length.toByte()))
    }
    else -> throw IllegalArgumentException("Unsupported key version ${key[0]}")
  }
  return digest.digest(key).joinToString("") { "%02X".format(it) }
}

fun megabytes(bytes: Long): String = "%.1f MB".format(bytes / 1_000_000.0)

/** Deletes a tree without following symlinks, making read-only directories writable first. */
fun deleteTree(root: File) {
  val start = root.toPath()
  if (!Files.exists(start, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return
  Files.walkFileTree(start, object : SimpleFileVisitor<Path>() {
    override fun preVisitDirectory(dir: Path, attributes: BasicFileAttributes): FileVisitResult {
      dir.toFile().setWritable(true, true)
      dir.toFile().setExecutable(true, true)
      return FileVisitResult.CONTINUE
    }

    override fun visitFile(file: Path, attributes: BasicFileAttributes): FileVisitResult {
      Files.delete(file)
      return FileVisitResult.CONTINUE
    }

    override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
      Files.delete(dir)
      return FileVisitResult.CONTINUE
    }
  })
}

private fun ByteArray.int32(at: Int): Int =
  ((this[at].toInt() and 0xFF) shl 24) or ((this[at + 1].toInt() and 0xFF) shl 16) or
    ((this[at + 2].toInt() and 0xFF) shl 8) or (this[at + 3].toInt() and 0xFF)

private fun ByteArray.field(offset: Int, length: Int): String {
  var end = offset
  while (end < offset + length && this[end].toInt() != 0) end++
  return String(this, offset, end - offset, Charsets.UTF_8)
}

private fun ByteArray.octal(offset: Int, length: Int): Long =
  field(offset, length).trim().ifEmpty { "0" }.toLong(8)

private fun ByteArray.cString(): String = String(this, Charsets.UTF_8).trimEnd('\u0000')

private fun parsePax(data: ByteArray): Map<String, String> {
  val records = HashMap<String, String>()
  var at = 0
  while (at < data.size) {
    var space = at
    while (space < data.size && data[space] != ' '.code.toByte()) space++
    val length = String(data, at, space - at, Charsets.US_ASCII).toIntOrNull() ?: break
    val record = String(data, space + 1, at + length - space - 2, Charsets.UTF_8)
    val equals = record.indexOf('=')
    if (equals > 0) records[record.substring(0, equals)] = record.substring(equals + 1)
    at += length
  }
  return records
}

/** Reads one 512-byte block; false at a clean end of stream. */
private fun InputStream.readBlock(block: ByteArray): Boolean {
  var read = 0
  while (read < block.size) {
    val count = read(block, read, block.size - read)
    if (count < 0) {
      if (read == 0) return false
      throw IOException("Truncated tar header")
    }
    read += count
  }
  return true
}

/** Copies an entry's data (or skips it when output is null), then its padding. */
private fun InputStream.copyEntry(output: OutputStream?, size: Long) {
  val buffer = ByteArray(1 shl 16)
  var remaining = size + (512 - size % 512) % 512
  var data = size
  while (remaining > 0) {
    val count = read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
    if (count < 0) throw IOException("Truncated tar entry")
    if (data > 0) output?.write(buffer, 0, minOf(count.toLong(), data).toInt())
    data -= count
    remaining -= count
  }
}

private fun InputStream.readEntry(size: Long): ByteArray =
  ByteArrayOutputStream().also { copyEntry(it, size) }.toByteArray()

/** All files access on Android 11+, the storage permission before it. */
fun hasStorageAccess(context: Context): Boolean =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    Environment.isExternalStorageManager()
  } else {
    context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
  }
