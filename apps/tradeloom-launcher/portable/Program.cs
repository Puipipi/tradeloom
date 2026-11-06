using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    private sealed class LauncherFailure : Exception
    {
        public string Code { get; private set; }
        public string UserMessage { get; private set; }
        public string ExitCode { get; private set; }

        public LauncherFailure(string code, string userMessage, string exitCode = null)
        {
            Code = code;
            UserMessage = userMessage;
            ExitCode = exitCode;
        }
    }

    private sealed class LauncherConfig
    {
        public int HostPort;
        public int DjangoPort;
        public int PostgresPort;
        public string DataDirectory;
    }

    [STAThread]
    private static int Main()
    {
        string launcherDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string errorCode = "START_FAILED";
        string userMessage = "启动工作台失败。请检查启动目录中的启动工作台.log。（START_FAILED）";
        string exitCode = null;

        try
        {
            string executablePath = Assembly.GetExecutingAssembly().Location;
            launcherDirectory = Path.GetDirectoryName(executablePath) ?? AppDomain.CurrentDomain.BaseDirectory;
            LauncherConfig config = ReadConfig(Path.Combine(launcherDirectory, "launcher.json"));
            string appDirectory = Path.GetFullPath(Path.Combine(launcherDirectory, "app"));
            string appPath = Path.GetFullPath(Path.Combine(appDirectory, "织贸助手.exe"));
            if (!File.Exists(appPath))
            {
                throw new LauncherFailure("APP_NOT_FOUND", "未找到 app\\织贸助手.exe。请将启动工作台.exe放回应用包根目录。（APP_NOT_FOUND）");
            }

            string dataRoot = Path.GetFullPath(Path.Combine(launcherDirectory, config.DataDirectory));
            string observationPath = Path.Combine(dataRoot, "logs", "desktop-startup-observation.jsonl");
            var startInfo = new ProcessStartInfo
            {
                FileName = appPath,
                Arguments = "--tradeloom-host-port " + config.HostPort.ToString(CultureInfo.InvariantCulture)
                    + " --tradeloom-django-port " + config.DjangoPort.ToString(CultureInfo.InvariantCulture)
                    + " --tradeloom-postgres-port " + config.PostgresPort.ToString(CultureInfo.InvariantCulture),
                WorkingDirectory = appDirectory,
                UseShellExecute = false,
                CreateNoWindow = false,
                WindowStyle = ProcessWindowStyle.Normal
            };
            startInfo.EnvironmentVariables["TRADELOOM_DATA_ROOT"] = dataRoot;
            startInfo.EnvironmentVariables["DSH_DESKTOP_STARTUP_LOG_PATH"] = observationPath;

            using (Process child = Process.Start(startInfo))
            {
                if (child == null)
                {
                    throw new LauncherFailure("START_FAILED", "无法创建织贸助手进程。请检查启动目录中的启动工作台.log。（START_FAILED）");
                }
                if (child.WaitForExit(15000) || child.HasExited)
                {
                    exitCode = unchecked((uint)child.ExitCode).ToString("X8", CultureInfo.InvariantCulture);
                    if (child.ExitCode != 0)
                    {
                        throw new LauncherFailure("CHILD_EXITED", "织贸助手在启动观察期内异常退出。退出码：0x" + exitCode + "。（CHILD_EXITED）", exitCode);
                    }
                    WriteLauncherEvent(launcherDirectory, "process-exited", child.Id, exitCode);
                    return 0;
                }
                WriteLauncherEvent(launcherDirectory, "process-started", child.Id, null);
            }
            return 0;
        }
        catch (LauncherFailure failure)
        {
            errorCode = failure.Code;
            userMessage = failure.UserMessage;
            exitCode = failure.ExitCode;
        }
        catch
        {
            errorCode = "START_FAILED";
            userMessage = "启动工作台失败。请检查启动目录中的启动工作台.log。（START_FAILED）";
        }

        WriteFailureLog(launcherDirectory, errorCode, exitCode);
        MessageBox.Show(userMessage, "启动工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    private static LauncherConfig ReadConfig(string configPath)
    {
        Dictionary<string, object> values;
        try
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 4096 };
            values = serializer.DeserializeObject(File.ReadAllText(configPath, Encoding.UTF8)) as Dictionary<string, object>;
        }
        catch
        {
            throw InvalidConfig();
        }

        string[] expectedKeys = { "schemaVersion", "dataDirectory", "hostPort", "djangoPort", "postgresPort" };
        if (values == null || values.Count != expectedKeys.Length)
        {
            throw InvalidConfig();
        }
        foreach (string key in expectedKeys)
        {
            if (!values.ContainsKey(key)) throw InvalidConfig();
        }

        try
        {
            int version = ReadInteger(values["schemaVersion"]);
            int hostPort = ReadInteger(values["hostPort"]);
            int djangoPort = ReadInteger(values["djangoPort"]);
            int postgresPort = ReadInteger(values["postgresPort"]);
            string dataDirectory = values["dataDirectory"] as string;
            if (version != 1 || !String.Equals(dataDirectory, "data-ui-r2", StringComparison.Ordinal)
                || hostPort != 3088 || djangoPort != 3090 || postgresPort != 55432)
            {
                throw InvalidConfig();
            }
            return new LauncherConfig
            {
                HostPort = hostPort,
                DjangoPort = djangoPort,
                PostgresPort = postgresPort,
                DataDirectory = dataDirectory
            };
        }
        catch (LauncherFailure)
        {
            throw;
        }
        catch
        {
            throw InvalidConfig();
        }
    }

    private static LauncherFailure InvalidConfig()
    {
        return new LauncherFailure("CONFIG_INVALID", "launcher.json 配置无效。请恢复随应用包提供的固定配置。（CONFIG_INVALID）");
    }

    private static int ReadInteger(object value)
    {
        if (value is int) return (int)value;
        if (value is long && (long)value >= Int32.MinValue && (long)value <= Int32.MaxValue) return (int)(long)value;
        throw InvalidConfig();
    }

    private static void WriteLauncherEvent(string launcherDirectory, string eventName, int processId, string exitCode)
    {
        try
        {
            string logPath = Path.Combine(launcherDirectory, "启动工作台.log");
            File.AppendAllText(logPath,
                DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture)
                    + " event=" + eventName + " pid=" + processId.ToString(CultureInfo.InvariantCulture)
                    + (exitCode == null ? "" : " exit=0x" + exitCode) + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch
        {
        }
    }

    private static void WriteFailureLog(string launcherDirectory, string code, string exitCode)
    {
        try
        {
            string logPath = Path.Combine(launcherDirectory, "启动工作台.log");
            File.AppendAllText(logPath,
                DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture)
                    + " event=launch-failed code=" + code
                    + (exitCode == null ? "" : " exit=0x" + exitCode) + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch
        {
        }
    }
}
