import uuid
from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):
    dependencies = [('workbench', '0012_canvas_workflow_run')]
    operations = [migrations.CreateModel(name='NativeArtifactVersion', fields=[
        ('id', models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
        ('node_id', models.CharField(max_length=128)), ('attempt', models.PositiveIntegerField()),
        *[(name, models.CharField(max_length=256)) for name in ('child_session_id','native_run_id','request_id','tool_call_id','parent_agent_id','parent_session_id')],
        ('binding_revision', models.CharField(max_length=128)), ('definition_revision', models.CharField(max_length=128)),
        ('source_session_seq', models.PositiveBigIntegerField()), ('file_index', models.PositiveIntegerField()),
        ('present_call_id', models.CharField(max_length=256)), ('source_turn', models.PositiveBigIntegerField()),
        ('grant_root_scope', models.CharField(max_length=256)), ('display_name', models.CharField(max_length=255)), ('mime_type', models.CharField(max_length=128)),
        ('byte_size', models.PositiveBigIntegerField()), ('sha256', models.CharField(max_length=64)),
        ('storage_key', models.CharField(max_length=500, unique=True)), ('created_at', models.DateTimeField(auto_now_add=True)),
        ('run', models.ForeignKey(to='workbench.canvasworkflowrun', on_delete=django.db.models.deletion.PROTECT, related_name='native_artifacts')),
    ], options={'constraints': [models.UniqueConstraint(fields=('run','node_id','attempt','source_session_seq','file_index'), name='uniq_native_artifact_coordinate')]})]
